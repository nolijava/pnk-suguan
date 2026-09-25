import { redirect } from "next/navigation";
import { requirePagePermission as requirePermission } from "@/server/auth/guard";
import { hasPermission } from "@/server/auth/permissions";
import { backupDir, listBackups } from "@/server/services/backup.service";
import { emailConfigurationProblem, isEmailConfigured, sendTestEmail } from "@/server/auth/email";
import { audit } from "@/server/services/audit.service";
import { Notice } from "@/app/(admin)/_components";
import { BackupActions } from "./backup-actions";

export const dynamic = "force-dynamic";

/**
 * Update #18 — Settings › Backup & Restore.
 * The page itself needs backups.read (VIEWER may see the catalog read-only);
 * the action buttons are gated per permission and the server re-checks anyway.
 *
 * New Update #2 — the same page carries the EMAIL DELIVERY card, because
 * "Forgot password" cannot deliver a code until this machine's SMTP settings
 * exist. The card reports the configuration state truthfully (never a secret)
 * and offers a delivery test, both restricted to `users.manage`.
 *
 * New Update #3 — the Super Admin reference PDF is linked from here for
 * ADMIN / SUPER_ADMIN.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("backups.read");
  const sp = await searchParams;
  const emailTest = typeof sp.emailTest === "string" ? sp.emailTest : undefined;
  const emailReason = typeof sp.reason === "string" ? sp.reason : undefined;

  const backups = await listBackups();
  const canManageUsers = hasPermission(user.roleCodes, "users.manage");
  const emailConfigured = isEmailConfigured();
  const emailProblem = emailConfigurationProblem();

  /**
   * Delivery test — audited, secret-free, and honest: it reports whether SMTP
   * actually accepted the message, so an operator can tell a configuration
   * problem apart from an inbox/deliverability problem.
   */
  async function testEmailAction() {
    "use server";
    const actor = await requirePermission("users.manage");
    const result = await sendTestEmail(actor.email);
    await audit({
      user: actor,
      action: "EMAIL_TEST_SENT",
      entityType: "user",
      entityId: actor.userId,
      newValue: { delivered: result.delivered },
      reason: result.problem ?? "email delivery test",
    });
    redirect(
      `/settings?emailTest=${result.delivered ? "delivered" : "failed"}&reason=${encodeURIComponent(result.problem ?? "")}`,
    );
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Backup and restore of this machine&apos;s application database, email delivery, and administrator documentation.</p>
        </div>
      </div>

      {emailTest === "delivered" ? (
        <Notice kind="success">
          Test email accepted by the mail server. If it does not arrive, check the recipient&apos;s spam folder — the
          system itself did deliver it.
        </Notice>
      ) : null}
      {emailTest === "failed" ? (
        <Notice kind="error">
          Test email was NOT sent. {emailReason ? `${emailReason}. ` : ""}Configure the SMTP keys in this machine&apos;s
          data folder and restart the application.
        </Notice>
      ) : null}

      {canManageUsers ? (
        <section className="card">
          <h2>Email delivery (Forgot password)</h2>
          {emailConfigured ? (
            <p>
              <span className="badge badge-green">CONFIGURED</span> SMTP is configured, so password-reset verification
              codes can be delivered from this machine.
            </p>
          ) : (
            <p>
              <span className="badge badge-amber">NOT CONFIGURED</span> {emailProblem ?? "SMTP is not configured."}{" "}
              Until it is, &ldquo;Forgot password&rdquo; cannot deliver a code to anyone — the request is still accepted
              silently, exactly as it is for an unknown address.
            </p>
          )}
          <dl className="detail-list">
            <dt>Sender</dt>
            <dd>The address in <code>PNK_SMTP_FROM</code>, or <code>PNK Suguan &lt;no-reply@localhost&gt;</code> when unset.</dd>
            <dt>Where it is configured</dt>
            <dd>
              This machine&apos;s data folder, in the <code>.env</code> file next to the database — never here, and never
              in the database. Keys: <code>PNK_SMTP_HOST</code>, <code>PNK_SMTP_PORT</code>,{" "}
              <code>PNK_SMTP_SECURE</code>, <code>PNK_SMTP_USER</code>, <code>PNK_SMTP_PASS</code>,{" "}
              <code>PNK_SMTP_FROM</code> (or the single <code>PNK_SMTP_URL</code>).
            </dd>
            <dt>After editing</dt>
            <dd>Restart the application so the launcher passes the new values to the server.</dd>
          </dl>
          <form action={testEmailAction} className="actions-row">
            <button className="btn btn-secondary" type="submit" disabled={!emailConfigured}>
              Send test email to my account
            </button>
            <span className="info-note">Sent to {user.email} · audited · contains no code and no credentials.</span>
          </form>
          <p className="info-note">
            The test proves SMTP connectivity only. Verification codes remain single-use, expire after 10 minutes, lock
            after five wrong attempts, and are never shown to another user or written to a log.
          </p>
        </section>
      ) : null}

      {user.roleCodes.includes("ADMIN") || user.roleCodes.includes("SUPER_ADMIN") ? (
        <section className="card">
          <h2>Administrator documentation</h2>
          <p className="info-note">
            Super Admin reference manual — access, capabilities, the emergency correction of a PUBLISHED week, backup and
            restore, provisioning and recovery. Procedures only: it contains no passwords and no secrets.
          </p>
          <div className="actions-row">
            <a className="btn btn-secondary" href="/guides/SUPER-ADMIN-GUIDE.pdf" rel="nofollow">
              Open Super Admin Guide (PDF)
            </a>
          </div>
        </section>
      ) : null}

      <BackupActions
        backups={backups}
        canBackup={hasPermission(user.roleCodes, "backups.write")}
        canRestore={hasPermission(user.roleCodes, "backups.restore")}
        defaultDir={backupDir()}
      />
    </>
  );
}
