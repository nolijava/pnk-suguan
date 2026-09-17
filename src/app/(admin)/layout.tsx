import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/guard";
import { logout } from "@/server/auth/auth.service";
import { SESSION_COOKIE } from "@/server/auth/session";
import { cookies } from "next/headers";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await requireUser();
  } catch {
    redirect("/login");
  }
  if (user.mustChangePassword) redirect("/change-password");

  async function action() {
    "use server";
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token) await logout(token);
    store.delete(SESSION_COOKIE);
    redirect("/login");
  }

  return (
    <>
      <nav>
        <strong>PNK Admin</strong>
        <a href="/">Dashboard</a>
        <a href="/teachers">Teachers</a>
        <a href="/dako">Dako</a>
        <a href="/availability">Availability</a>
        <a href="/schedule">Schedule</a>
        <a href="/historical">Historical</a>
        {user.roleCodes.includes("ADMIN") ? <a href="/audit-logs">Audit</a> : null}
        <span style={{ marginLeft: "auto", color: "#555", fontSize: 13 }}>
          {user.email} [{user.roleCodes.join(", ")}]
        </span>
        <form action={action}>
          <button className="ghost" type="submit">Sign out</button>
        </form>
      </nav>
      <main>{children}</main>
    </>
  );
}
