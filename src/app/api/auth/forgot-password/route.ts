import { ok, fail, parseBody } from "@/server/api/helpers";
import { forgotPasswordSchema } from "@/lib/validation/schemas";
import {
  requestPasswordReset,
  clientIpFrom,
  GENERIC_RESET_MESSAGE,
} from "@/server/auth/password-reset.service";

/**
 * POST /api/auth/forgot-password — public (unauthenticated by design).
 *
 * Always answers 200 with the same generic message so the endpoint can never
 * be used to discover whether an account exists. Rate limiting and delivery
 * happen server-side; nothing about them is observable here. `no-store` keeps
 * the response out of any cache.
 */
export async function POST(req: Request) {
  try {
    const body = forgotPasswordSchema.parse(await parseBody(req));
    const result = await requestPasswordReset(body.email, clientIpFrom(req));
    return ok(
      { message: result.message ?? GENERIC_RESET_MESSAGE },
      200,
      { "cache-control": "no-store" },
    );
  } catch (err) {
    return fail(err);
  }
}
