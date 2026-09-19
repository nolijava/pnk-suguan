import { ok, fail, parseBody } from "@/server/api/helpers";
import { resetPasswordSchema } from "@/lib/validation/schemas";
import { completePasswordReset } from "@/server/auth/password-reset.service";

/**
 * POST /api/auth/reset-password — public (unauthenticated by design).
 *
 * Completes a recovery against the one-time ticket minted by
 * /api/auth/verify-reset-code. The ticket is the only scope: it can only ever
 * act on the account it was issued for, it expires, and it is consumed in the
 * same transaction that writes the new argon2id hash. Every existing session of
 * that account is revoked afterwards, so the user must sign in again with the
 * new password. The password value never appears in a response, a log, an audit
 * row, or a URL.
 */
export async function POST(req: Request) {
  try {
    const body = resetPasswordSchema.parse(await parseBody(req));
    await completePasswordReset(body.ticket, body.newPassword);
    return ok({ ok: true }, 200, { "cache-control": "no-store" });
  } catch (err) {
    return fail(err);
  }
}
