import { ok, fail, parseBody, parseQuery } from "@/server/api/helpers";
import { requirePermission } from "@/server/auth/guard";
import { UserManagementService } from "@/server/services";
import { userListQuerySchema, userCreateSchema } from "@/lib/validation/schemas";

/**
 * Phase 10 — user list for the User Management page. Read-only projection of
 * accounts (the service layer never exposes passwordHash). Optional
 * server-side search (email/fullName), role and status filters.
 */
export async function GET(req: Request) {
  try {
    // Authorization first, then the filters. This used to `safeParse` and fall
    // back to `{}`, so a malformed filter was silently DROPPED — the list came
    // back unfiltered with no indication why.
    const actor = await requirePermission("users.manage");
    const filters = parseQuery(req, userListQuerySchema);
    return ok(await UserManagementService.listUsers(filters, actor));
  } catch (err) {
    return fail(err);
  }
}

/**
 * Create user (existing workflow, now service-backed): temporary password
 * supplied by the admin, argon2id-hashed, mustChangePassword forces rotation
 * on first login. SUPER_ADMIN is not an assignable role (schema-enforced).
 */
export async function POST(req: Request) {
  try {
    const actor = await requirePermission("users.manage");
    const body = userCreateSchema.parse(await parseBody(req));
    return ok(await UserManagementService.createUser(body, actor), 201);
  } catch (err) {
    return fail(err);
  }
}
