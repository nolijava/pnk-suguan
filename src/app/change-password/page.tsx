import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requireUser } from "@/server/auth/guard";
import { changePassword } from "@/server/auth/auth.service";
import { SESSION_COOKIE } from "@/server/auth/session";
import { checkPasswordStrength } from "@/lib/password-strength";

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let user;
  try {
    user = await requireUser();
  } catch {
    redirect("/login");
  }
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : undefined;
  const strength = checkPasswordStrength("");

  async function action(formData: FormData) {
    "use server";
    try {
      const userId = (await requireUser()).userId;
      const current = String(formData.get("currentPassword") ?? "");
      const next = String(formData.get("newPassword") ?? "");
      const okStrength = checkPasswordStrength(next);
      if (!okStrength.ok) {
        redirect(`/change-password?error=${encodeURIComponent(okStrength.checks.filter((c) => !c.ok).map((c) => c.rule).join("; "))}`);
      }
      await changePassword(userId, current, next);
      // Sessions were revoked; force a fresh login.
      const store = await cookies();
      store.delete(SESSION_COOKIE);
      redirect("/login");
    } catch (e) {
      if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e;
      redirect(`/change-password?error=${encodeURIComponent(e instanceof Error ? e.message : "change failed")}`);
    }
  }

  return (
    <main style={{ maxWidth: 420, margin: "10vh auto" }}>
      <h1>Change password</h1>
      <p style={{ color: "#555" }}>
        Signed in as {user?.email}. Minimum policy: {strength.checks.map((c) => c.rule).join(", ")}.
      </p>
      {error ? <p className="error">{error}</p> : null}
      <form action={action} className="inline" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <label>Current password<input name="currentPassword" type="password" required /></label>
        <label>New password<input name="newPassword" type="password" required /></label>
        <button type="submit">Update password</button>
      </form>
    </main>
  );
}
