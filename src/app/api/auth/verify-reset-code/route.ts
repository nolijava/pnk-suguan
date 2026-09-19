import { ok, fail, parseBody } from "@/server/api/helpers";
import { verifyResetCodeSchema } from "@/lib/validation/schemas";
import { verifyResetCode } from "@/server/auth/password-reset.service";
import { ValidationError } from "@/lib/errors";

/** Same message for a wrong code, an expired code, an attempt cap and a missing account. */
const INVALID_CODE = "Invalid or expired code.";

/**
 * POST /api/auth/verify-reset-code — public (unauthenticated by design).
 *
 * On success returns the single-use reset ticket (scoped to that account only);
 * anything else returns an identical 422. The code itself is validated
 * server-side with a timing-safe comparison and is never echoed back.
 */
export async function POST(req: Request) {
  try {
    const body = verifyResetCodeSchema.parse(await parseBody(req));
    const result = await verifyResetCode(body.email, body.code);
    if (!result) throw new ValidationError(INVALID_CODE);
    return ok({ ticket: result.ticket }, 200, { "cache-control": "no-store" });
  } catch (err) {
    return fail(err);
  }
}
