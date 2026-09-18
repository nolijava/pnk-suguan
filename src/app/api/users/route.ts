import { ok, fail, parseBody } from "@/server/api/helpers";
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
    const url = new URL(req.url);
    const flat = Object.fromEntries(url.searchParams.entries());
    const parsed = userListQuerySchema.safeParse(flat);
    const filters = parsed.success ? parsed.data : {};
    const actor = await requirePermission("users.manage");
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
