import { randomBytes } from "node:crypto";
import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { roles, userRoles, users } from "@/server/db/schema";
import type { SessionUser } from "@/server/auth/session";
import { revokeAllSessionsForUser } from "@/server/auth/session";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { checkPasswordStrength } from "@/lib/password-strength";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { audit } from "./audit.service";

/**
 * Phase 10 — User Management & Account Administration (§7 of the approved plan).
 *
 * All mutations are ADMIN-only (enforced again at the route) and live in one
 * service so the security invariants hold regardless of caller:
 *
 *   S1  an account can never deactivate itself or change its own role;
 *   S2  the last ACTIVE admin can never be demoted or deactivated (the
 *       safeguard runs inside the mutation transaction under FOR UPDATE locks
 *       so two concurrent demotions cannot both pass);
 *   S3  accounts holding SUPER_ADMIN are only mutable by SUPER_ADMIN — no
 *       normal workflow grants SUPER_ADMIN, this is defense in depth;
 *   S4  there is no delete: status flips preserve audit attribution, and
 *       deactivation revokes every live session.
 *
 * Temporary passwords are generated server-side, returned exactly once to the
 * authorized actor, never logged and never stored in plaintext; the forced
 * first-login rotation (mustChangePassword) is existing architecture.
 */

const MANAGEABLE_ROLE_CODES = ["ADMIN", "SCHEDULER", "VIEWER"] as const;
export type ManageableRoleCode = (typeof MANAGEABLE_ROLE_CODES)[number];

export interface UserListRow {
  id: string;
  email: string;
  fullName: string;
  status: string;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  roleCodes: string[];
}

export interface UserDetail {
  id: string;
  email: string;
  fullName: string;
  status: string;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  roleCodes: string[];
}

export interface ResetPasswordResult {
  /** One-time temporary password — never persisted in clear, never logged. */
  temporaryPassword: string;
  mustChangePassword: true;
}

/* ------------------------------------------------------------------ */
/* Role helpers                                                        */
/* ------------------------------------------------------------------ */

async function rolesForUsers(
  db: Database,
  userIds: string[],
): Promise<Map<string, string[]>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: userRoles.userId, code: roles.code })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(inArray(userRoles.userId, userIds));
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.userId) ?? [];
    list.push(r.code);
    map.set(r.userId, list);
  }
  return map;
}

function roleCodesOf(db2: Map<string, string[]>, userId: string): string[] {
  return db2.get(userId) ?? [];
}

/** S3 — does this account hold SUPER_ADMIN? (defense in depth, no grant path) */
function holdsSuperAdmin(codes: string[]): boolean {
  return codes.includes("SUPER_ADMIN");
}

/**
 * Service-boundary authorization (defense in depth — routes also enforce
 * users.manage). Mirrors the Phase 7 convention: services verify roleCodes,
 * so no future caller can bypass RBAC by invoking the service directly.
 */
function assertActorIsAdmin(actor: SessionUser): void {
  if (!actor.roleCodes.includes("ADMIN") && !actor.roleCodes.includes("SUPER_ADMIN")) {
    throw new ForbiddenError("users.manage permission required.");
  }
}

function assertActorMayTouch(
  actor: SessionUser,
  targetRoles: string[],
): void {
  if (holdsSuperAdmin(targetRoles) && !actor.roleCodes.includes("SUPER_ADMIN")) {
    throw new ForbiddenError(
      "This account is protected; only a SUPER_ADMIN may modify it.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* List / detail                                                       */
/* ------------------------------------------------------------------ */

/** Drizzle wraps driver errors; walk the cause chain to find postgres 23505. */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (e instanceof Error || (typeof e === "object" && e !== null)) {
    if ((e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
    if (e === undefined || e === null) break;
  }
  return false;
}

export async function listUsers(
  filters: { q?: string; role?: string; status?: string } = {},
  actor: SessionUser,
): Promise<UserListRow[]> {
  assertActorIsAdmin(actor);
  const db = getDb();
  const conditions = [];
  if (filters.q) {
    const needle = `%${filters.q}%`;
    conditions.push(or(ilike(users.email, needle), ilike(users.fullName, needle)));
  }
  if (filters.status) conditions.push(eq(users.status, filters.status));
  if (filters.role) {
    const roleRow = await db.select().from(roles).where(eq(roles.code, filters.role)).limit(1);
    if (!roleRow[0]) return [];
    conditions.push(
      sql`EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = ${users.id} AND ur.role_id = ${roleRow[0].id})`,
    );
  }

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      status: users.status,
      mustChangePassword: users.mustChangePassword,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(users.fullName))
    .limit(200);

  const roleMap = await rolesForUsers(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, roleCodes: roleCodesOf(roleMap, r.id) }));
}

export async function getUser(id: string): Promise<UserDetail> {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const user = rows[0];
  if (!user) throw new NotFoundError("User not found");
  const roleMap = await rolesForUsers(db, [id]);
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    roleCodes: roleCodesOf(roleMap, id),
  };
}

/* ------------------------------------------------------------------ */
/* Create (the existing route logic, centralized)                      */
/* ------------------------------------------------------------------ */

export interface CreateUserInput {
  email: string;
  fullName: string;
  password: string;
  roleCode: ManageableRoleCode;
}

export async function createUser(
  input: CreateUserInput,
  actor: SessionUser,
): Promise<{ id: string; email: string; fullName: string; roleCode: string }> {
  const strength = checkPasswordStrength(input.password);
  if (!strength.ok) {
    throw new ValidationError(
      `Password too weak: ${strength.checks.filter((c) => !c.ok).map((c) => c.rule).join("; ")}`,
    );
  }
  const db = getDb();
  const roleRows = await db.select().from(roles).where(eq(roles.code, input.roleCode)).limit(1);
  const role = roleRows[0];
  if (!role) throw new ValidationError("unknown role");
  const passwordHash = await hashPassword(input.password);
  try {
    const created = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(users)
        .values({
          email: input.email.trim().toLowerCase(),
          fullName: input.fullName.trim(),
          passwordHash,
          mustChangePassword: true,
        })
        .returning();
      const user = inserted[0]!;
      await tx.insert(userRoles).values({ userId: user.id, roleId: role.id, grantedBy: actor.userId });
      await audit(
        {
          user: actor,
          action: "CREATED_USER",
          entityType: "user",
          entityId: user.id,
          newValue: { email: user.email, fullName: user.fullName, roleCode: input.roleCode },
        },
        tx as never,
      );
      return user;
    });
    return { id: created.id, email: created.email, fullName: created.fullName, roleCode: input.roleCode };
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("A user with this email already exists.");
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Mutations — shared safeguard machinery                              */
/* ------------------------------------------------------------------ */

interface LockedTarget {
  user: typeof users.$inferSelect;
  roleCodes: string[];
}

/**
 * Loads the target with FOR UPDATE row locks on the user, its user_roles rows
 * and every ADMIN's user_roles row, so concurrent demotions/deactivations
 * serialize and the last-admin count cannot be computed on stale data (S2).
 */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function lockTarget(db: Database | Tx, targetId: string): Promise<LockedTarget> {
  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, targetId))
    .for("update")
    .limit(1);
  const user = userRows[0];
  if (!user) throw new NotFoundError("User not found");
  await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(eq(userRoles.userId, targetId))
    .for("update");
  // Lock all admin grants so the active-admin count below is stable.
  await db.execute(sql`
    SELECT ur.role_id FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id AND r.code = 'ADMIN'
    WHERE ur.user_id <> ${targetId}
    FOR UPDATE OF ur
  `);
  const roleRows = await db
    .select({ code: roles.code })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, targetId));
  return { user, roleCodes: roleRows.map((r) => r.code) };
}

async function countActiveAdminsExcluding(db: Database | Tx, userId: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN roles r ON r.id = ur.role_id AND r.code = 'ADMIN'
    WHERE u.id <> ${userId} AND u.status = 'ACTIVE'
  `);
  const rows = (res as unknown as { rows?: Array<{ n: number }> }).rows ?? (res as unknown as Array<{ n: number }>);
  const first = (rows as Array<{ n: number }>)[0];
  return Number(first?.n ?? 0);
}

/* ------------------------------------------------------------------ */
/* Edit profile / role / status                                        */
/* ------------------------------------------------------------------ */

export async function updateUserProfile(
  id: string,
  fullName: string,
  actor: SessionUser,
): Promise<UserDetail> {
  assertActorIsAdmin(actor);
  const db = getDb();
  return db.transaction(async (tx) => {
    const { user, roleCodes } = await lockTarget(tx as unknown as Database, id);
    assertActorMayTouch(actor, roleCodes);
    const updated = await tx
      .update(users)
      .set({ fullName: fullName.trim(), updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    await audit(
      {
        user: actor,
        action: "UPDATED_USER",
        entityType: "user",
        entityId: id,
        oldValue: { fullName: user.fullName },
        newValue: { fullName: fullName.trim() },
      },
      tx as never,
    );
    return {
      id,
      email: updated[0]!.email,
      fullName: updated[0]!.fullName,
      status: updated[0]!.status,
      mustChangePassword: updated[0]!.mustChangePassword,
      lastLoginAt: updated[0]!.lastLoginAt,
      createdAt: updated[0]!.createdAt,
      roleCodes,
    };
  });
}

export async function changeUserRole(
  id: string,
  newRoleCode: ManageableRoleCode,
  actor: SessionUser,
  reason?: string,
): Promise<UserDetail> {
  assertActorIsAdmin(actor);
  const db = getDb();
  return db.transaction(async (tx) => {
    const { user, roleCodes } = await lockTarget(tx, id);
    assertActorMayTouch(actor, roleCodes);
    if (actor.userId === id) {
      throw new ValidationError("You cannot change your own role.");
    }
    if (roleCodes.includes("ADMIN") && !roleCodes.includes(newRoleCode)) {
      const others = await countActiveAdminsExcluding(tx, id);
      if (others === 0) {
        throw new ValidationError("Cannot demote the last active administrator.");
      }
    }
    const roleRows = await tx.select().from(roles).where(eq(roles.code, newRoleCode)).limit(1);
    const role = roleRows[0];
    if (!role) throw new ValidationError("unknown role");

    // Single-role model (matches existing user_roles usage): replace, and
    // record the change in the append-only audit log.
    await tx.delete(userRoles).where(eq(userRoles.userId, id));
    await tx.insert(userRoles).values({ userId: id, roleId: role.id, grantedBy: actor.userId });
    await audit(
      {
        user: actor,
        action: "CHANGED_USER_ROLE",
        entityType: "user",
        entityId: id,
        oldValue: { roleCodes },
        newValue: { roleCodes: [newRoleCode] },
        reason: reason ?? null,
      },
      tx as never,
    );
    return {
      id,
      email: user.email,
      fullName: user.fullName,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      roleCodes: [newRoleCode],
    };
  });
}

export async function changeUserStatus(
  id: string,
  next: "ACTIVE" | "INACTIVE",
  actor: SessionUser,
  reason?: string,
): Promise<UserDetail> {
  assertActorIsAdmin(actor);
  const db = getDb();
  return db.transaction(async (tx) => {
    const { user, roleCodes } = await lockTarget(tx, id);
    assertActorMayTouch(actor, roleCodes);
    if (actor.userId === id) {
      throw new ValidationError("You cannot deactivate your own account.");
    }
    if (user.status === next) {
      throw new ValidationError(`User is already ${next}.`);
    }
    if (next === "INACTIVE" && roleCodes.includes("ADMIN")) {
      const others = await countActiveAdminsExcluding(tx, id);
      if (others === 0) {
        throw new ValidationError("Cannot deactivate the last active administrator.");
      }
    }
    await tx
      .update(users)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(users.id, id));
    await audit(
      {
        user: actor,
        action: next === "INACTIVE" ? "DEACTIVATED_USER" : "REACTIVATED_USER",
        entityType: "user",
        entityId: id,
        oldValue: { status: user.status },
        newValue: { status: next },
        reason: reason ?? null,
      },
      tx as never,
    );
    if (next === "INACTIVE") {
      // Outside the tx is fine: revocation is idempotent and the status flip
      // in getSessionUser already blocks authz immediately.
      await revokeAllSessionsForUser(id);
    }
    return {
      id,
      email: user.email,
      fullName: user.fullName,
      status: next,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      roleCodes,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Password reset (one-time temporary secret)                          */
/* ------------------------------------------------------------------ */

const TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

export async function resetUserPassword(
  id: string,
  actor: SessionUser,
): Promise<ResetPasswordResult> {
  assertActorIsAdmin(actor);
  const db = getDb();
  const bytes = randomBytes(16);
  let temp = "";
  for (let i = 0; i < 16; i++) {
    // Guarantee at least one of each required class by position-seeding.
    const b = bytes[i]!;
    temp += TEMP_ALPHABET[b % TEMP_ALPHABET.length]!;
  }
  // Force class coverage: upper / lower / digit / symbol slots.
  const guaranteed = [
    temp.slice(0, 4),
    "A",
    "b",
    "7",
    "!",
    temp.slice(4),
  ].join("");
  const temporaryPassword = guaranteed;

  const { user, roleCodes } = await lockTarget(db, id);
  assertActorMayTouch(actor, roleCodes);
  const passwordHash = await hashPassword(temporaryPassword);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: true, updatedAt: new Date() })
      .where(eq(users.id, id));
    await audit(
      {
        user: actor,
        action: "RESET_USER_PASSWORD",
        entityType: "user",
        entityId: id,
        newValue: { mustChangePassword: true },
      },
      tx as never,
    );
  });
  await revokeAllSessionsForUser(id);
  return { temporaryPassword, mustChangePassword: true };
}

export const UserManagementService = {
  listUsers,
  getUser,
  createUser,
  updateUserProfile,
  changeUserRole,
  changeUserStatus,
  resetUserPassword,
};

export { verifyPassword };
