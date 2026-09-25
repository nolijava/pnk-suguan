import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUserOrNull } from "@/server/auth/guard";
import { login } from "@/server/auth/auth.service";
import { SESSION_COOKIE } from "@/server/auth/session";
import { cookies } from "next/headers";
import { BrandMark } from "@/app/_components/brand-mark";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUserOrNull();
  if (user) redirect(user.mustChangePassword ? "/change-password" : "/");
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : undefined;

  async function action(formData: FormData) {
    "use server";
    try {
      const email = String(formData.get("email") ?? "");
      const password = String(formData.get("password") ?? "");
      const result = await login(email, password);
      const store = await cookies();
      store.set(SESSION_COOKIE, result.token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        expires: result.expiresAt,
      });
      redirect(result.mustChangePassword ? "/change-password" : "/");
    } catch (e) {
      if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e;
      redirect(`/login?error=${encodeURIComponent(e instanceof Error ? e.message : "login failed")}`);
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <div>
            <h1>PNK Suguan System</h1>
            <p className="auth-sub">Teacher Assignment &amp; Suguan Management</p>
          </div>
        </div>
        {error ? (
          <p className="error-note" role="alert">
            {error}
          </p>
        ) : null}
        <form action={action} className="form-col" style={{ marginTop: error ? 12 : 0 }}>
          <label className="field">
            <span>
              Email <em>*</em>
            </span>
            <input name="email" type="email" required autoComplete="username" />
          </label>
          <label className="field">
            <span>
              Password <em>*</em>
            </span>
            <input name="password" type="password" required autoComplete="current-password" />
          </label>
          <button type="submit" className="btn btn-primary auth-submit">
            Sign in
          </button>
          <div className="auth-links">
            <Link className="link-btn" href="/forgot-password">
              Forgot password?
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
