/**
 * Phase 8 — approved in-process anniversary notification delivery.
 *
 * ONE application-level timer (~every 6 hours) drives the EXISTING
 * idempotent notification service (dueAnniversaryNotifications +
 * recordDakoAnniversaryNotification). The DB unique index on
 * (dako, anniversaryYear, notificationType) remains the authoritative
 * dedupe: repeated scans are no-ops and a restart self-heals on the next
 * tick. No second notification engine; no external channels.
 *
 * The module-level guard prevents duplicate timers when Next.js re-evaluates
 * this module during development/HMR. This is a delivery mechanism only —
 * notifications never trigger any scheduling action (Invariant 16).
 */

export async function register() {
  // Phase 8 approved approach. If this runtime cannot host an in-process
  // timer safely, the failure must be reported — not silently substituted.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const g = globalThis as typeof globalThis & {
    __pnkAnniversaryTimer?: NodeJS.Timeout;
    __pnkDbCheckStarted?: boolean;
    __pnkEmailCheckStarted?: boolean;
  };

  // Post-release hardening — advisory startup database check (see
  // server/db/startup-check.ts): prints which database the app ACTUALLY uses
  // and warns when the config file disagrees (the stale-.env class of drift).
  // Fire-and-forget: it must never block or break startup, and it never logs
  // passwords. Once per process (HMR-safe), like the timer below.
  if (!g.__pnkDbCheckStarted) {
    g.__pnkDbCheckStarted = true;
    void import("@/server/db/startup-check")
      .then((m) => m.runDatabaseStartupCheck())
      .catch((err) => console.warn("[db-check] check skipped:", err instanceof Error ? err.message : err));
  }

  // New Update #2 — ONE secret-free startup line when password-reset email
  // cannot be delivered at all. A forgotten SMTP configuration previously
  // produced only a silently discarded code (with the response deliberately
  // unchanged, to avoid an account-existence oracle); this line makes the
  // configuration gap visible in the log without ever revealing a value.
  if (!g.__pnkEmailCheckStarted) {
    g.__pnkEmailCheckStarted = true;
    void import("@/server/auth/email")
      .then((m) => {
        if (!m.isEmailConfigured()) {
          console.warn(
            `[email] password-reset email is NOT configured — ${m.emailConfigurationProblem() ?? "SMTP unavailable"}`,
          );
        }
      })
      .catch(() => console.warn("[email] configuration check skipped"));
  }

  if (g.__pnkAnniversaryTimer) return; // module-level guard: never double-start

  const INTERVAL_MS = 6 * 60 * 60 * 1000; // approximately every 6 hours

  async function scanOnce() {
    try {
      const { runDueAnniversaryScan } = await import("@/server/services/notification.service");
      const res = await runDueAnniversaryScan();
      if (res.dueStages > 0) {
        console.log(
          `[anniversary-notifier] scanned ${res.scannedDakos} due stage(s); created ${res.createdNotifications} notification(s).`,
        );
      }
    } catch (err) {
      // Never crash the app over a notification pass; the next tick retries
      // idempotently (DB dedupe guarantees no duplicates).
      console.error("[anniversary-notifier] scan failed (will retry next tick):", err);
    }
  }

  // First pass shortly after boot, then on the fixed interval.
  g.__pnkAnniversaryTimer = setInterval(scanOnce, INTERVAL_MS);
  const t = setTimeout(scanOnce, 5_000);
  if (typeof t.unref === "function") t.unref(); // never hold the process open
  if (typeof g.__pnkAnniversaryTimer.unref === "function") g.__pnkAnniversaryTimer.unref();
}
