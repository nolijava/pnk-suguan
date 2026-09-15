import { ok, fail, parseBody } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { users, roles, userRoles } from "@/server/db/schema";
import { profiles } from "@/server/db/sql-views";
import { eq } from "drizzle-orm";
import { userCreateSchema } from "@/lib/validation/schemas";
import { hashPassword } from "@/server/auth/password";
import { checkPasswordStrength } from "@/lib/password-strength";
import { ValidationError, ConflictError } from "@/lib/errors";
import { audit } from "@/server/services/audit.service";
import { sql } from "drizzle-orm";

export async function GET() {
  try {
    await requirePermission("users.manage");
    const rows = await getDb().select().from(profiles).orderBy(profiles.fullName);
    return ok(rows);
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  try {
    const actor = await requirePermission("users.manage");
    const body = userCreateSchema.parse(await parseBody(req));
    const strength = checkPasswordStrength(body.password);
    if (!strength.ok) {
      throw new ValidationError(`Password too weak: ${strength.checks.filter((c) => !c.ok).map((c) => c.rule).join("; ")}`);
    }
    const db = getDb();
    const roleRows = await db.select().from(roles).where(eq(roles.code, body.roleCode)).limit(1);
    const role = roleRows[0];
    if (!role) throw new ValidationError("unknown role");
    const passwordHash = await hashPassword(body.password);
    try {
      const created = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(users)
          .values({ email: body.email.toLowerCase(), fullName: body.fullName, passwordHash, mustChangePassword: true })
          .returning();
        const user = inserted[0]!;
        await tx.insert(userRoles).values({ userId: user.id, roleId: role.id, grantedBy: actor.userId });
        await audit(
          { user: actor, action: "CREATED_USER", entityType: "user", entityId: user.id, newValue: { email: user.email, fullName: user.fullName, roleCode: body.roleCode } },
          tx as never,
        );
        return user;
      });
      return ok({ id: created.id, email: created.email, fullName: created.fullName, roleCode: body.roleCode }, 201);
    } catch (err: unknown) {
      if (typeof err === "object" && err && (err as { code?: string }).code === "23505") {
        throw new ConflictError("email already exists");
      }
      throw err;
    }
  } catch (err) {
    return fail(err);
  }
}

void sql;
