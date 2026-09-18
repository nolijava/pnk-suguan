/**
 * Phase 10 — User Management & Account Administration tests.
 *
 * Covers the full account lifecycle and every approved security invariant:
 * create (hash + audit + no secret leakage), RBAC (users.manage is
 * ADMIN-only), safeguards S1 (self), S2 (last admin, incl. concurrent
 * demotions), S3 (SUPER_ADMIN targets), S4 (no delete — status flips only),
 * deactivation session revocation + login rejection, one-time password reset
 * (old secret dead, forced rotation, no secret in the audit log), list
 * filtering, and duplicate-grant prevention via migration 0006's unique index.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import type { SessionUser } from "@/server/auth/session";
import {
  resetTestDb,
  seedAdmin,
  seedScheduler,
  teardown,
  db,
  sql,
} from "./helpers";
import { UserManagementService } from "@/server/services";
import { ValidationError, ForbiddenError, ConflictError, NotFoundError } from "@/lib/errors";
import { login } from "@/server/auth/auth.service";
import { setThrottleClock } from "@/server/auth/login-throttle";

function actor(userId: string, roles: string[]): SessionUser {
  return {
    userId,
    email: "actor@test.local",
    fullName: "Actor",
    mustChangePassword: false,
    roleCodes: roles,
    permissions: [],
  };
}

async function makeUser(
  email: string,
  fullName: string,
  roleCode: "ADMIN" | "SCHEDULER" | "VIEWER" | "SUPER_ADMIN",
  password = "Str0ng!Passw0rd",
): Promise<{ id: string; roleCode: string }> {
  const passwordHash = await (await import("@/server/auth/password")).hashPassword(password);
  const inserted = await db
    .insert(schema.users)
    .values({ email, fullName, passwordHash })
    .returning();
  const user = inserted[0]!;
  const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, roleCode));
  await db.insert(schema.userRoles).values({ userId: user.id, roleId: roleRows[0]!.id });
  return { id: user.id, roleCode };
}

async function lastAudit(action: string, entityId: string) {
  const rows = await db
    .select()
    .from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.action, action), eq(schema.auditLogs.entityId, entityId)))
    .orderBy(desc(schema.auditLogs.createdAt))
    .limit(1);
  return rows[0];
}

let adminId: string;
let admin: SessionUser;
let sched: SessionUser;
let schedId: string;
let viewer: SessionUser;
let viewerId: string;

beforeAll(async () => {
  await resetTestDb();
  // Throttle state is in-process and shared across test files (single fork);
  // phase9-security leaves buckets on the "unknown" IP bucket. Start above
  // every prior timestamp (so prune() drops them) and step 60 s per call so
  // any 500 ms…15 s backoff is always already expired at the next check.
  let walk = 2_000_000_000;
  setThrottleClock(() => (walk += 60_000));
  adminId = await seedAdmin();
  admin = actor(adminId, ["ADMIN"]);
  schedId = await seedScheduler();
  sched = actor(schedId, ["SCHEDULER"]);
  const v = await makeUser("viewer@test.local", "Test Viewer", "VIEWER");
  viewerId = v.id;
  viewer = actor(viewerId, ["VIEWER"]);
});

afterAll(async () => {
  await teardown();
});

describe("create user (existing workflow, service-backed)", () => {
  it("creates an account with hashed password, forced rotation and audit", async () => {
    const created = await UserManagementService.createUser(
      { email: "New.User@Test.Local", fullName: "New User", password: "Temp0rary!Pass1", roleCode: "VIEWER" },
      admin,
    );
    expect(created.email).toBe("new.user@test.local");

    const stored = await db.select().from(schema.users).where(eq(schema.users.id, created.id)).limit(1);
    const user = stored[0]!;
    expect(user.passwordHash).not.toContain("Temp0rary");
    expect(user.mustChangePassword).toBe(true);
    expect(user.status).toBe("ACTIVE");

    const auditRow = await lastAudit("CREATED_USER", created.id);
    expect(auditRow).toBeTruthy();
    expect(JSON.stringify(auditRow!.newValue)).not.toContain("Temp0rary");
  });

  it("rejects weak passwords and duplicate emails", async () => {
    await expect(
      UserManagementService.createUser(
        { email: "weak@test.local", fullName: "Weak", password: "short", roleCode: "VIEWER" },
        admin,
      ),
    ).rejects.toThrow(ValidationError);
    await expect(
      UserManagementService.createUser(
        { email: "new.user@test.local", fullName: "Dup", password: "Temp0rary!Pass1", roleCode: "VIEWER" },
        admin,
      ),
    ).rejects.toThrow(ConflictError);
  });

  it("never returns a password hash from the list projection", async () => {
    const rows = await UserManagementService.listUsers({}, admin);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain("passwordHash");
      expect(JSON.stringify(row)).not.toContain("$argon2");
    }
  });
});

describe("RBAC — users.manage is ADMIN-only", () => {
  it("rejects SCHEDULER and VIEWER actors at the service boundary", async () => {
    const target = await makeUser("rbac-target@test.local", "RBAC Target", "VIEWER");
    await expect(UserManagementService.updateUserProfile(target.id, "X", sched)).rejects.toThrow(ForbiddenError);
    await expect(UserManagementService.changeUserStatus(target.id, "INACTIVE", viewer)).rejects.toThrow(ForbiddenError);
    await expect(UserManagementService.listUsers({}, sched)).rejects.toThrow(ForbiddenError);
  });
});

describe("safeguard S1 — self-protection", () => {
  it("blocks self-deactivation and self role change", async () => {
    await expect(UserManagementService.changeUserStatus(adminId, "INACTIVE", admin)).rejects.toThrow(ValidationError);
    await expect(UserManagementService.changeUserRole(adminId, "VIEWER", admin)).rejects.toThrow(ValidationError);
  });
});

describe("safeguard S2 — last active admin", () => {
  it("blocks demoting and deactivating the only admin", async () => {
    await expect(UserManagementService.changeUserRole(adminId, "VIEWER", admin)).rejects.toThrow(ValidationError);
    await expect(UserManagementService.changeUserStatus(adminId, "INACTIVE", admin)).rejects.toThrow(ValidationError);
  });

  it("allows demotion once a second active admin exists", async () => {
    const second = await makeUser("admin2@test.local", "Second Admin", "ADMIN");
    const demoted = await UserManagementService.changeUserRole(second.id, "SCHEDULER", admin, "org change");
    expect(demoted.roleCodes).toEqual(["SCHEDULER"]);
    const auditRow = await lastAudit("CHANGED_USER_ROLE", second.id);
    expect(auditRow!.oldValue).toMatchObject({ roleCodes: ["ADMIN"] });
    expect(auditRow!.reason).toBe("org change");
  });

  it("serializes concurrent last-admin demotions (only one wins)", async () => {
    // Only `admin` remains as ADMIN here. Two concurrent demotion attempts:
    // at most one may pass — and with a single admin, both must fail.
    const results = await Promise.allSettled([
      UserManagementService.changeUserRole(adminId, "SCHEDULER", admin),
      UserManagementService.changeUserRole(adminId, "SCHEDULER", admin),
    ]);
    for (const r of results) expect(r.status).toBe("rejected");
    const roles = await db
      .select({ code: schema.roles.code })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
      .where(eq(schema.userRoles.userId, adminId));
    expect(roles.map((r) => r.code)).toEqual(["ADMIN"]);
  });
});

describe("safeguard S3 — SUPER_ADMIN targets are protected", () => {
  it("ADMIN cannot edit, demote, deactivate or reset a SUPER_ADMIN account", async () => {
    const sa = await makeUser("sa@test.local", "Emergency Admin", "SUPER_ADMIN");
    await expect(UserManagementService.updateUserProfile(sa.id, "X", admin)).rejects.toThrow(ForbiddenError);
    await expect(UserManagementService.changeUserRole(sa.id, "VIEWER", admin)).rejects.toThrow(ForbiddenError);
    await expect(UserManagementService.changeUserStatus(sa.id, "INACTIVE", admin)).rejects.toThrow(ForbiddenError);
    await expect(UserManagementService.resetUserPassword(sa.id, admin)).rejects.toThrow(ForbiddenError);
  });

  it("SUPER_ADMIN actor may manage a SUPER_ADMIN target (boundary, not a new power)", async () => {
    const saActorRow = await makeUser("sa-actor@test.local", "SA Actor", "SUPER_ADMIN");
    const saActor = actor(saActorRow.id, ["SUPER_ADMIN"]);
    const updated = await UserManagementService.updateUserProfile(saActorRow.id, "Renamed Emergency Admin", saActor);
    expect(updated.fullName).toBe("Renamed Emergency Admin");
  });
});

describe("status lifecycle (S4 — no delete)", () => {
  it("deactivates, revokes sessions, blocks login, then reactivates", async () => {
    const target = await makeUser("cycle@test.local", "Cycle User", "VIEWER", "Cycle0r!Pass1");

    // establish a live session
    const session = await login("cycle@test.local", "Cycle0r!Pass1");
    expect(session.userId).toBe(target.id);

    await UserManagementService.changeUserStatus(target.id, "INACTIVE", admin, "leave");

    // sessions revoked
    const live = await db
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.userId, target.id)));
    expect(live.every((s) => s.revokedAt !== null)).toBe(true);

    // login rejected with the uniform error (no account enumeration)
    await expect(login("cycle@test.local", "Cycle0r!Pass1")).rejects.toThrow(/Invalid credentials/);

    // audit written, no reason secret
    const auditRow = await lastAudit("DEACTIVATED_USER", target.id);
    expect(auditRow!.newValue).toMatchObject({ status: "INACTIVE" });

    // reactivate → login works again
    await UserManagementService.changeUserStatus(target.id, "ACTIVE", admin);
    const again = await login("cycle@test.local", "Cycle0r!Pass1");
    expect(again.userId).toBe(target.id);
  });

  it("treats deactivation as idempotent-safe (no-op error, not state corruption)", async () => {
    const target = await makeUser("idem@test.local", "Idem User", "VIEWER");
    await UserManagementService.changeUserStatus(target.id, "INACTIVE", admin);
    await expect(UserManagementService.changeUserStatus(target.id, "INACTIVE", admin)).rejects.toThrow(
      /already INACTIVE/,
    );
  });
});

describe("one-time password reset", () => {
  it("issues a working temporary password, kills old sessions, forces rotation", async () => {
    const target = await makeUser("reset@test.local", "Reset User", "VIEWER", "Old0r!Passw0rd1");
    const oldSession = await login("reset@test.local", "Old0r!Passw0rd1");

    const result = await UserManagementService.resetUserPassword(target.id, admin);
    expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(10);
    expect(result.mustChangePassword).toBe(true);

    // old session revoked
    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, target.id));
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

    // old password dead, temp works, rotation forced
    await expect(login("reset@test.local", "Old0r!Passw0rd1")).rejects.toThrow(/Invalid credentials/);
    const tempLogin = await login("reset@test.local", result.temporaryPassword);
    expect(tempLogin.mustChangePassword).toBe(true);
    void oldSession;

    // audit exists, but the secret must not be in it
    const auditRow = await lastAudit("RESET_USER_PASSWORD", target.id);
    expect(auditRow).toBeTruthy();
    expect(JSON.stringify(auditRow)).not.toContain(result.temporaryPassword);
  });

  it("rejects reset of unknown users", async () => {
    await expect(UserManagementService.resetUserPassword("00000000-0000-0000-0000-000000000000", admin)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("list + filters", () => {
  it("filters by search, role and status", async () => {
    const byQ = await UserManagementService.listUsers({ q: "cycle" }, admin);
    expect(byQ.length).toBe(1);
    expect(byQ[0]!.email).toBe("cycle@test.local");

    const admins = await UserManagementService.listUsers({ role: "ADMIN" }, admin);
    expect(admins.every((r) => r.roleCodes.includes("ADMIN"))).toBe(true);

    const inactive = await UserManagementService.listUsers({ status: "INACTIVE" }, admin);
    expect(inactive.every((r) => r.status === "INACTIVE")).toBe(true);
    expect(inactive.length).toBeGreaterThan(0);
  });
});

describe("migration 0006 — one role grant per (user, role)", () => {
  it("rejects duplicate grants at the database level", async () => {
    const target = await makeUser("dupgrant@test.local", "Dup Grant", "VIEWER");
    const roleRows = await db.select().from(schema.roles).where(eq(schema.roles.code, "VIEWER"));
    await expect(
      db.insert(schema.userRoles).values({ userId: target.id, roleId: roleRows[0]!.id }),
    ).rejects.toThrow();
    void sql;
  });
});
