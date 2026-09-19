import { redirect } from "next/navigation";
import { currentUserOrNull } from "@/server/auth/guard";
import { ForgotPasswordClient } from "./forgot-password-client";

export const dynamic = "force-dynamic";

/**
 * /forgot-password — public self-service recovery (Group 1).
 *
 * A signed-in user has no reason to be here, so they are sent to the app (or to
 * the forced password change). Everything else is handled by the client flow,
 * which talks to the three /api/auth/* recovery endpoints; none of those
 * endpoints trusts anything from this page.
 */
export default async function ForgotPasswordPage() {
  const user = await currentUserOrNull();
  if (user) redirect(user.mustChangePassword ? "/change-password" : "/");
  return <ForgotPasswordClient />;
}
