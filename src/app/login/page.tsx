import { redirect } from "next/navigation";
import { currentUserOrNull } from "@/server/auth/guard";
import { login } from "@/server/auth/auth.service";
import { SESSION_COOKIE } from "@/server/auth/session";
import { cookies } from "next/headers";

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
    <main style={{ maxWidth: 380, margin: "10vh auto" }}>
      <h1>PNK Suguan System</h1>
      <p style={{ color: "#555" }}>Teacher Assignment & Suguan Management</p>
      {error ? <p className="error">{error}</p> : null}
      <form action={action} className="inline" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <label>Email<input name="email" type="email" required /></label>
        <label>Password<input name="password" type="password" required /></label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
