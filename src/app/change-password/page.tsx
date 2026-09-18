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
    <main className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            PNK
          </span>
          <div>
            <h1>Change password</h1>
            <p className="auth-sub">Signed in as {user?.email}</p>
          </div>
        </div>
        <p className="info-note" style={{ marginTop: 0 }}>
          Minimum policy: {strength.checks.map((c) => c.rule).join(", ")}.
        </p>
        {error ? (
          <p className="error-note" role="alert">
            {error}
          </p>
        ) : null}
        <form action={action} className="form-col">
          <label className="field">
            <span>
              Current password <em>*</em>
            </span>
            <input name="currentPassword" type="password" required autoComplete="current-password" />
          </label>
          <label className="field">
            <span>
              New password <em>*</em>
            </span>
            <input name="newPassword" type="password" required autoComplete="new-password" />
          </label>
          <button type="submit" className="btn btn-primary" style={{ justifyContent: "center" }}>
            Update password
          </button>
        </form>
      </div>
    </main>
  );
}
