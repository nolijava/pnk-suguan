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
    <div ref={rootRef} className="notif-bell" style={{ position: "relative" }}>
      <button
        type="button"
        className="btn btn-secondary"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unreadCount ? `Notifications (${unreadCount} unread)` : "Notifications"}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) load();
        }}
      >
        🔔{unreadCount ? <span className="notif-count">{unreadCount}</span> : null}
      </button>

      {open ? (
        <div className="notif-panel modal" role="dialog" aria-label="Notifications" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", width: 380, maxHeight: 480, overflowY: "auto", zIndex: 1000 }}>
          <h3 style={{ marginTop: 0 }}>Notifications</h3>
          {err ? <p className="error" role="alert">{err}</p> : null}
          {items === null ? (
            <p className="info-note">Loading…</p>
          ) : items.length === 0 ? (
            <p className="info-note">No notifications.</p>
          ) : (
            <ul className="notif-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {items.map((n) => {
                const href = notificationHref(n.relatedEntityType, n.relatedEntityId);
                return (
                  <li key={n.id} className={n.readAt ? "notif-item notif-read" : "notif-item notif-unread"} style={{ borderTop: "1px solid #e5e7eb", padding: "8px 0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <strong style={{ fontSize: 13 }}>{n.title}</strong>
                      {!n.readAt ? (
                        <button type="button" className="link-btn" disabled={busy} onClick={() => markRead(n.id)}>
                          mark read
                        </button>
                      ) : null}
                    </div>
                    <div className="info-note" style={{ fontSize: 12 }}>
                      <span className="badge badge-gray">{notificationTypeLabel(n.notificationType)}</span>{" "}
                      {relativeTime(n.createdAt)}
                      {n.readAt ? " · read" : " · unread"}
                    </div>
                    {n.message ? <p style={{ margin: "4px 0 0", fontSize: 13 }}>{n.message}</p> : null}
                    {href ? (
                      <a href={href} style={{ fontSize: 13 }} onClick={() => setOpen(false)}>
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
