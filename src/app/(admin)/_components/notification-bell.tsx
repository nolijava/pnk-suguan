"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notificationHref, notificationTypeLabel, relativeTime } from "@/lib/notification-links";

interface NotificationRow {
  id: string;
  notificationType: string;
  title: string;
  message: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * Phase 8 — notification bell (Part M). Unread count + dropdown panel with
 * title, message, category label, relative timestamp, mark-as-read (owned
 * rows only — enforced again server-side by /api/notifications POST), and
 * navigation by relatedEntityType (dako → /dako/[id], week → /schedule).
 * Visible to every role holding notifications.read. Read-only beyond the
 * user's own notification rows — never triggers scheduling actions.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const unreadCount = items ? items.filter((n) => !n.readAt).length : null;

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await fetch("/api/notifications");
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? "failed to load notifications");
      setItems((body.data ?? []) as NotificationRow[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to load notifications");
    }
  }, []);

  // Load on mount and whenever the panel opens; refresh on window focus.
  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function markRead(id: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notificationIds: [id] }),
      });
      if (res.ok) {
        setItems((prev) => prev?.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)) ?? null);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="icon-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unreadCount ? `Notifications (${unreadCount} unread)` : "Notifications"}
        title="Notifications"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) load();
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
          <path d="M13.7 20a2 2 0 0 1-3.4 0" />
        </svg>
        {unreadCount ? <span className="bell-count">{unreadCount}</span> : null}
      </button>

      {open ? (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="bell-head">
            <strong>Notifications</strong>
            {unreadCount ? <span className="chip chip-accent">{unreadCount} unread</span> : null}
          </div>
          {err ? <p className="error" role="alert" style={{ padding: "0 14px" }}>{err}</p> : null}
          {items === null ? (
            <div className="bell-list" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div className="bell-item" key={i}>
                  <div className="skeleton skeleton-line" style={{ width: "58%" }} />
                  <div className="skeleton skeleton-line" style={{ width: "82%" }} />
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="info-note" style={{ padding: "16px 14px" }}>
              No notifications. Dako anniversary reminders appear here.
            </p>
          ) : (
            <ul className="bell-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {items.map((n) => {
                const href = notificationHref(n.relatedEntityType, n.relatedEntityId);
                return (
                  <li key={n.id} className="bell-item" data-unread={n.readAt ? "false" : "true"}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                      <span className="bell-item-title">{n.title}</span>
                      {!n.readAt ? (
                        <button type="button" className="link-btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => markRead(n.id)}>
                          mark read
                        </button>
                      ) : null}
                    </div>
                    <div className="bell-item-meta">
                      <span className="badge badge-gray">{notificationTypeLabel(n.notificationType)}</span>
                      <span>{relativeTime(n.createdAt)}</span>
                      <span>{n.readAt ? "· read" : "· unread"}</span>
                    </div>
                    {n.message ? <p className="bell-item-body">{n.message}</p> : null}
                    {href ? (
                      <a href={href} style={{ fontSize: 12.5 }} onClick={() => setOpen(false)}>
                        View related page →
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
