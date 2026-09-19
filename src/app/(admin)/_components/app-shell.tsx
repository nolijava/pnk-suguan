"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { THEME_COOKIE, THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

/**
 * Application shell (visual layer only). Renders the sidebar navigation exactly
 * as before — same items, same order, RBAC-gated entries are decided by the
 * server layout and passed in as flags. Adds presentation concerns only:
 * collapse state (persisted), mobile drawer, theme toggle. No routing,
 * permission, or data logic lives here.
 */

const ICONS: Record<string, React.ReactNode> = {
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </svg>
  ),
  teachers: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5" />
      <path d="M16.5 5.5a3 3 0 0 1 0 5.6" />
      <path d="M18 20c0-2.4-.7-4.2-2-5.3" />
    </svg>
  ),
  dako: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 21V9.5L12 4l8 5.5V21" />
      <path d="M9.5 21v-6h5v6" />
      <path d="M2.5 21h19" />
    </svg>
  ),
  availability: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
      <path d="m9 15 2 2 4-4" />
    </svg>
  ),
  schedule: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="16" rx="2.2" />
      <path d="M3.5 9.5h17M9 9.5V20M15 9.5V20" />
    </svg>
  ),
  historical: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 12a8.5 8.5 0 1 0 3-6.5" />
      <path d="M3.5 4.5V10h5.5" />
      <path d="M12 8v4.5l3 1.8" />
    </svg>
  ),
  reports: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20V4.5" />
      <path d="M4 20h16" />
      <path d="M8 20v-6M12.5 20V8.5M17 20v-9" />
    </svg>
  ),
  audit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7.5 3v6c0 4.2-3 7.6-7.5 9-4.5-1.4-7.5-4.8-7.5-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="3" />
      <path d="M3 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <circle cx="17" cy="9.5" r="2.4" />
      <path d="M16 15.2c2.7.3 4.5 2.1 4.5 4.8" />
    </svg>
  ),
  collapse: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.5 6.5 9 12l5.5 5.5" />
    </svg>
  ),
  menu: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  ),
  sun: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.6v2M12 19.4v2M4.2 4.2l1.5 1.5M18.3 18.3l1.5 1.5M2.6 12h2M19.4 12h2M4.2 19.8l1.5-1.5M18.3 5.7l1.5-1.5" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </svg>
  ),
};

const PAGE_TITLES: Array<[string, string, string]> = [
  ["/teachers", "Teachers", "Master data, language, and current destination"],
  ["/dako", "Dako", "Congregation records and teacher destination history"],
  ["/availability", "Availability", "Weekly availability encoding"],
  ["/schedule", "Weekly Schedule", "SUGO · RESERBA · RESERBA II"],
  ["/historical", "Historical Backfill", "Pre-go-live assignment encoding"],
  ["/reports", "Reports", "Read-only operational reports"],
  ["/audit-logs", "Audit Log", "Administrative action history"],
  ["/users", "User Management", "Accounts, roles, and access"],
];

export interface ShellNavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
}

export function AppShell({
  children,
  navItems,
  userEmail,
  roleLabel,
  signOut,
  bell,
}: {
  children: React.ReactNode;
  navItems: ShellNavItem[];
  userEmail: string;
  roleLabel: string;
  signOut: () => Promise<void>;
  bell: React.ReactNode;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("light");
  const [scrolled, setScrolled] = useState(false);
  const tipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem("pnk-shell-collapsed") : null;
    if (stored === "true") setCollapsed(true);
    // The DOM is the source of truth: the server rendered it from the cookie and
    // the pre-paint bootstrap latched it, so the toggle never misreports.
    const current = document.documentElement.dataset.theme;
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Header readability: once content scrolls under the sticky bar it becomes
  // ~95% opaque (see .topbar[data-scrolled="true"]).
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  /**
   * Collapsed-rail tooltip. The old ::after tooltip was clipped by the rail's
   * `overflow: hidden` and, because the rail also has `backdrop-filter`, any
   * positioned descendant would be rooted at the rail itself. So the tooltip is
   * a body-level layer: never clipped, above page content, hidden on scroll,
   * resize, route change, and whenever the rail expands.
   */
  useEffect(() => {
    const tip = document.createElement("div");
    tip.className = "nav-tooltip";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
    tipRef.current = tip;
    const hide = () => tip.classList.remove("show");
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
      tip.remove();
      tipRef.current = null;
    };
  }, []);

  const hideRailTip = useCallback(() => {
    tipRef.current?.classList.remove("show");
  }, []);

  const showRailTip = useCallback(
    (target: EventTarget | null) => {
      const tip = tipRef.current;
      const item = (target as HTMLElement | null)?.closest(".nav-item") as HTMLElement | null;
      if (!tip || !item || !collapsed || window.innerWidth <= 900) return;
      const label = item.getAttribute("data-label");
      if (!label) return;
      tip.textContent = label;
      const rect = item.getBoundingClientRect();
      tip.style.left = `${Math.round(rect.right + 12)}px`;
      tip.style.top = `${Math.round(rect.top + rect.height / 2)}px`;
      tip.classList.add("show");
    },
    [collapsed],
  );

  // A collapsing rail (or a new route) never leaves a stale label floating.
  useEffect(() => {
    hideRailTip();
  }, [collapsed, pathname, hideRailTip]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("pnk-shell-collapsed", String(next));
      } catch {
        /* storage unavailable — collapse still works for this session */
      }
      return next;
    });
  }, []);

  const toggleTheme = useCallback(() => {
    // Read the live DOM value (not component state) so the toggle can never
    // drift out of sync, then persist to BOTH stores: the cookie is what the
    // server renders next time, localStorage covers cookie-less contexts.
    const current: Theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const next: Theme = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — theme still applies for this session */
    }
    try {
      document.cookie = `${THEME_COOKIE}=${next};path=/;max-age=31536000;samesite=lax`;
    } catch {
      /* cookies unavailable — localStorage still carries the choice */
    }
  }, []);

  const page = PAGE_TITLES.find(([href]) => pathname === href || pathname.startsWith(`${href}/`));
  const initials = userEmail.slice(0, 2).toUpperCase();

  return (
    <div className="shell" data-collapsed={collapsed ? "true" : "false"}>
      <aside className="sidebar" data-open={drawerOpen ? "true" : "false"} aria-label="Primary">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            PNK
          </span>
          <span className="brand-text">
            <strong>PNK Suguan</strong>
            <span>Assignment Management</span>
          </span>
        </div>

        <span className="nav-section-label">Workspace</span>
        <nav
          style={{ display: "flex", flexDirection: "column", gap: 2, padding: 0, background: "none", border: "none" }}
          onMouseOver={(e) => showRailTip(e.target)}
          onMouseLeave={hideRailTip}
          onFocusCapture={(e) => showRailTip(e.target)}
          onBlurCapture={hideRailTip}
        >
          {navItems.map((item) => {
            const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`));
            return (
              <Link
                key={item.href}
                href={item.href}
                className="nav-item"
                data-label={item.label}
                aria-current={active ? "page" : undefined}
              >
                {ICONS[item.icon]}
                <span className="nav-label">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <button
            type="button"
            className="collapse-btn desktop-only"
            onClick={toggleCollapsed}
            aria-pressed={collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {ICONS.collapse}
            <span className="sidebar-foot-text">{collapsed ? "Expand" : "Collapse"}</span>
          </button>
        </div>
      </aside>

      {drawerOpen ? (
        <div className="drawer-backdrop" role="presentation" onClick={() => setDrawerOpen(false)} />
      ) : null}

      <div className="main-col">
        <header className="topbar" data-scrolled={scrolled ? "true" : undefined}>
          <button
            type="button"
            className="icon-btn mobile-only"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label="Toggle navigation"
          >
            {ICONS.menu}
          </button>
          <div className="topbar-title">
            <strong>{page ? page[1] : "Dashboard"}</strong>
            <span>{page ? page[2] : "Annual Suguan schedule overview"}</span>
          </div>
          <div className="topbar-actions">
            {bell}
            <button
              type="button"
              className="icon-btn"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              title={theme === "dark" ? "Light theme" : "Dark theme"}
            >
              {theme === "dark" ? ICONS.sun : ICONS.moon}
            </button>
            <div className="user-chip" title={`${userEmail} · ${roleLabel}`}>
              <span className="user-avatar" aria-hidden="true">
                {initials}
              </span>
              <span className="user-meta">
                <span>{userEmail}</span>
                <span>{roleLabel}</span>
              </span>
            </div>
            <form action={signOut}>
              <button className="btn btn-ghost" type="submit">
                Sign out
              </button>
            </form>
          </div>
        </header>
        <main className="content page-enter">{children}</main>
      </div>
    </div>
  );
}
