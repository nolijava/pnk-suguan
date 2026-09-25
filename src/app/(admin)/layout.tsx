import { redirect } from "next/navigation";
import { requirePageUser as requireUser } from "@/server/auth/guard";
import { logout } from "@/server/auth/auth.service";
import { SESSION_COOKIE } from "@/server/auth/session";
import { hasPermission } from "@/server/auth/permissions";
import { cookies } from "next/headers";
import { NotificationBell } from "./_components/notification-bell";
import { AppShell, type ShellNavItem } from "./_components/app-shell";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // requireUser is the page-safe variant (aliased import): an expired session
  // redirects straight to /login instead of racing the page's guard into a
  // stack-trace error page.
  const user = await requireUser();
  if (user.mustChangePassword) redirect("/change-password");

  async function action() {
    "use server";
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token) await logout(token);
    store.delete(SESSION_COOKIE);
    redirect("/login");
  }

  // New Update #11 — navigation is grouped into exactly five top-level items
  // (Dashboard · Schedule · Reports · Settings · Audit). The ROUTES are
  // unchanged, so nothing needs a redirect; only where a page is reached from
  // moved. Every entry keeps the SAME permission gate it had before, and each
  // page still enforces its own permission server-side — nav visibility has
  // never been the security boundary. The bell stays gated on
  // notifications.read.
  const canManageUsers = hasPermission(user.roleCodes, "users.manage");
  // Update #18 — Backup & Restore lives under Settings; VIEWER never sees it.
  const canSeeBackups =
    hasPermission(user.roleCodes, "backups.write") || hasPermission(user.roleCodes, "backups.restore");

  const scheduleItems: ShellNavItem[] = [
    { href: "/schedule", label: "Weekly Schedule", icon: "schedule" },
    { href: "/availability", label: "Availability", icon: "availability" },
    { href: "/magtuturo", label: "Magtuturo", icon: "magtuturo" },
    { href: "/historical", label: "Historical Backfill", icon: "historical" },
  ];

  const settingsItems: ShellNavItem[] = [
    { href: "/teachers", label: "Teachers", icon: "teachers" },
    { href: "/dako", label: "Dako", icon: "dako" },
  ];
  if (canManageUsers) {
    settingsItems.push({ href: "/users", label: "Users", icon: "users" });
  }
  if (canSeeBackups) {
    settingsItems.push({ href: "/settings", label: "Backup/Restore", icon: "settings" });
  }

  const navItems: ShellNavItem[] = [
    { href: "/", label: "Dashboard", icon: "dashboard" },
    { href: "/schedule", label: "Schedule", icon: "schedule", children: scheduleItems },
    { href: "/reports", label: "Reports", icon: "reports" },
    { href: "/settings", label: "Settings", icon: "settings", children: settingsItems },
  ];
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
