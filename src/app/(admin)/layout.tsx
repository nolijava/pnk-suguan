import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/guard";
import { logout } from "@/server/auth/auth.service";
import { SESSION_COOKIE } from "@/server/auth/session";
import { hasPermission } from "@/server/auth/permissions";
import { cookies } from "next/headers";
import { NotificationBell } from "./_components/notification-bell";
import { AppShell, type ShellNavItem } from "./_components/app-shell";

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

  // Same items, same visibility rules as before (Audit stays ADMIN-only;
  // the bell stays gated on notifications.read). Pages continue to enforce
  // their own permissions server-side.
  const navItems: ShellNavItem[] = [
    { href: "/", label: "Dashboard", icon: "dashboard" },
    { href: "/teachers", label: "Teachers", icon: "teachers" },
    { href: "/dako", label: "Dako", icon: "dako" },
    { href: "/availability", label: "Availability", icon: "availability" },
    { href: "/schedule", label: "Schedule", icon: "schedule" },
    { href: "/historical", label: "Historical", icon: "historical" },
    { href: "/reports", label: "Reports", icon: "reports" },
  ];
  if (hasPermission(user.roleCodes, "users.manage")) {
    navItems.push({ href: "/users", label: "Users", icon: "users" });
  }
  if (user.roleCodes.includes("ADMIN")) {
    navItems.push({ href: "/audit-logs", label: "Audit", icon: "audit" });
  }

  return (
    <AppShell
      navItems={navItems}
      userEmail={user.email}
      roleLabel={user.roleCodes.join(" · ")}
      signOut={action}
      bell={hasPermission(user.roleCodes, "notifications.read") ? <NotificationBell /> : null}
    >
      {children}
    </AppShell>
  );
}
