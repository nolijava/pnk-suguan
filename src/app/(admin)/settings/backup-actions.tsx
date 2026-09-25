"use client";

/**
 * Update #18 — Settings › Backup/Restore.
 * Update #18+ (Backup location options + Restore from other location):
 *  - "Create backup" opens a LOCATION CHOICE modal first: Default Location /
 *    Choose Different Location (native Windows Save As dialog via the trusted
 *    backend) / Cancel — then the existing confirmation shows the destination
 *    before the backup runs. One backup mechanism, one confirmation.
 *  - "Restore from file…" is a dedicated button: native Open dialog (any local
 *    drive/folder), the picked backup is inspected and reviewed before the
 *    strong typed confirmation. The picked file is never copied, moved or
 *    deleted here.
 *  - The existing default-folder list + per-row "Restore…" stay exactly as they
 *    were. Browser code never touches the filesystem — it only ever holds
 *    single-use pick tokens.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/app/(admin)/_components";
import { Notice } from "@/app/(admin)/_components";

type BackupFile = { name: string; sizeBytes: number; createdAt: string; destination?: string };
type BackupFileInspect = {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  sha256: string;
  valid: boolean;
  entries: number | null;
  error: string | null;
};

interface Props {
  backups: BackupFile[];
  canBackup: boolean;
  canRestore: boolean;
  /** The configured default backup directory (%LOCALAPPDATA%\PNK Suguan\backups). */
  defaultDir: string;
}

type Msg = { kind: "success" | "error" | "info"; text: string } | null;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function BackupActions({ backups, canBackup, canRestore, defaultDir }: Props) {
  const router = useRouter();
  // Create flow: location choice → destination confirmation → backup.
  const [locOpen, setLocOpen] = useState(false);
  const [confirmCreate, setConfirmCreate] = useState<{ destination: string; pickToken?: string } | null>(null);
  // Restore-from-file flow: pick → inspect/review → strong confirm.
  const [pickInfo, setPickInfo] = useState<{ token: string; inspect: BackupFileInspect } | null>(null);
  // Existing per-row restore flow (default backups folder) — unchanged.
  const [restoreTarget, setRestoreTarget] = useState<BackupFile | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [message, setMessage] = useState<Msg>(null);

  async function handleCustomDestination() {
    setPicking(true);
    setMessage(null);
    try {
      const res = await fetch("/api/backups/pick-destination", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setMessage({ kind: "error", text: body?.error?.message ?? "Could not open the folder picker." });
        return;
      }
      const data = body?.data ?? body;
      if (data?.cancelled) {
        setMessage({ kind: "info", text: "Location selection cancelled — no backup was created." });
        return;
      }
      setLocOpen(false);
      setConfirmCreate({ destination: data.displayPath ?? data.directory, pickToken: data.token });
    } catch {
      setMessage({ kind: "error", text: "Could not open the folder picker." });
    } finally {
      setPicking(false);
    }
  }

  async function handleCreate() {
    const target = confirmCreate;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target?.pickToken ? { pickToken: target.pickToken } : {}),
      });
      const body = await res.json();
      if (!res.ok) {
        setMessage({ kind: "error", text: body?.error?.message ?? "Backup failed — no backup record was created." });
        return;
      }
      const data = body?.data ?? body;
      setConfirmCreate(null);
      setMessage({
        kind: "success",
        text: `Backup created: ${data.name} → ${data.destination ?? defaultDir} · integrity verified.`,
      });
      router.refresh(); // re-render the server-side backup list
    } catch {
      setMessage({ kind: "error", text: "Backup failed — the destination could not be written." });
    } finally {
      setBusy(false);
    }
  }

  async function handlePickRestoreFile() {
    setPicking(true);
    setMessage(null);
    try {
      const res = await fetch("/api/backups/pick-file", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setMessage({ kind: "error", text: body?.error?.message ?? "Could not open the file picker." });
        return;
      }
      const data = body?.data ?? body;
      if (data?.cancelled) {
        setMessage({ kind: "info", text: "File selection cancelled — nothing was restored." });
        return;
      }
      setConfirmText("");
      setPickInfo({ token: data.token, inspect: data.inspect });
    } catch {
      setMessage({ kind: "error", text: "Could not open the file picker." });
    } finally {
      setPicking(false);
    }
  }

  async function handleRestoreFile() {
    const picked = pickInfo;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/backups/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pickToken: picked?.token, confirm: confirmText }),
      });
      const body = await res.json();
      if (!res.ok) {
        setMessage({ kind: "error", text: body?.error?.message ?? "Restore failed." });
        return;
      }
      const data = body?.data ?? body;
      setPickInfo(null);
      setConfirmText("");
      setMessage({
        kind: "success",
        text: `Restored ${data.restored} (${data.source === "external" ? "other location" : "backups folder"}) into ${data.targetDatabase}. Safety backup: ${data.safetyBackup}. Restart required.`,
      });
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: "Restore failed." });
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    const target = restoreTarget;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/backups/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: target?.name, confirm: confirmText }),
      });
      const body = await res.json();
      if (!res.ok) {
        setMessage({ kind: "error", text: body?.error?.message ?? "Restore failed." });
        return;
      }
      const data = body?.data ?? body;
      setRestoreTarget(null);
      setConfirmText("");
      setMessage({
        kind: "success",
        text: `Restored ${data.restored} into ${data.targetDatabase ?? "the application database"}. Safety backup: ${data.safetyBackup}. Restart required.`,
      });
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: "Restore failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="mb-1">Backup / Restore</h2>
      <p className="text-muted mb-3">
        Backups are full PostgreSQL dumps with integrity validation and audit. The default destination is the
        per-user backups folder; you can also save a backup to another local location and restore from any backup
        file you choose. Restores always create a safety backup first and require confirmation.
      </p>

      <div className="mb-3 flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" onClick={() => { setMessage(null); setLocOpen(true); }} disabled={!canBackup}>
          Create backup
        </button>
        <button type="button" className="btn btn-secondary" onClick={handlePickRestoreFile} disabled={!canRestore || picking}>
          {picking ? "Waiting for dialog…" : "Restore from file…"}
        </button>
      </div>

      {message ? <Notice kind={message.kind}>{message.text}</Notice> : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Created</th>
              <th style={{ textAlign: "right" }}>Size</th>
              <th style={{ textAlign: "right" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {backups.length ? (
              backups.map((b) => (
                <tr key={b.name}>
                  <td>{b.name}</td>
                  <td>{formatDate(b.createdAt)}</td>
                  <td style={{ textAlign: "right" }}>{formatBytes(b.sizeBytes)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!canRestore}
                      onClick={() => {
                        setMessage(null);
                        setConfirmText("");
                        setRestoreTarget(b);
                      }}
                    >
                      Restore…
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4}>No backups yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create — Step 1: location choice */}
      {locOpen ? (
        <Modal open onClose={() => setLocOpen(false)}>
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Backup location">
            <div className="modal">
              <h2>Where should the backup be saved?</h2>
              <p>Choose the destination for the new PostgreSQL backup file.</p>
              <p className="text-muted mb-1">Default location:</p>
              <p className="info-note" style={{ wordBreak: "break-all" }}>{defaultDir}</p>
              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setLocOpen(false)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleCustomDestination} disabled={picking}>
                  {picking ? "Waiting for dialog…" : "Choose Different Location"}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => { setLocOpen(false); setMessage(null); setConfirmCreate({ destination: defaultDir }); }}
                >
                  Default Location
                </button>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* Create — Step 2: the confirmation shows the destination before running */}
      {confirmCreate ? (
        <Modal open onClose={() => !busy && setConfirmCreate(null)}>
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Create backup">
            <div className="modal">
              <h2>Create backup?</h2>
              <p>This creates a full PostgreSQL backup of the PNK Suguan database and validates the archive.</p>
              <p className="text-muted mb-1">Destination:</p>
              <p className="info-note" style={{ wordBreak: "break-all" }}>{confirmCreate.destination}</p>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setConfirmCreate(null)} disabled={busy}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={busy}>
                  {busy ? "Creating…" : "Create backup"}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* Restore from file — review the picked backup, then the strong confirm */}
      {pickInfo ? (
        <Modal open onClose={() => !busy && setPickInfo(null)}>
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Restore backup from file">
            <div className="modal">
              <h2>Restore backup from file</h2>
              <p>
                The selected file was inspected with PostgreSQL tooling. A safety backup of the current database is
                created before the restore.
              </p>
              <dl className="mb-3">
                <InfoRow k="File">{pickInfo.inspect.name}</InfoRow>
                <InfoRow k="Location">{pickInfo.inspect.path}</InfoRow>
                <InfoRow k="Size">{formatBytes(pickInfo.inspect.sizeBytes)}</InfoRow>
                <InfoRow k="Modified">{formatDate(pickInfo.inspect.modifiedAt)}</InfoRow>
                <InfoRow k="SHA-256">
                  <span style={{ fontFamily: "monospace", fontSize: "0.8rem" }} title={pickInfo.inspect.sha256}>
                    {pickInfo.inspect.sha256.slice(0, 16) || "—"}…
                  </span>
                </InfoRow>
                <InfoRow k="Validation">
                  {pickInfo.inspect.valid ? (
                    <span>Valid PostgreSQL backup · {pickInfo.inspect.entries} entries</span>
                  ) : (
                    <span className="error">{pickInfo.inspect.error ?? "Invalid backup"}</span>
                  )}
                </InfoRow>
              </dl>
              {pickInfo.inspect.valid ? (
                <>
                  <p className="error">
                    Restoring replaces the current database contents with this backup. This cannot be undone except
                    by the automatic safety backup taken first. Type <strong>{pickInfo.inspect.name}</strong> to
                    confirm.
                  </p>
                  <label>
                    Type the backup file name to confirm
                    <input
                      value={confirmText}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmText(e.target.value)}
                      placeholder={pickInfo.inspect.name}
                      autoFocus
                    />
                  </label>
                  <div className="modal-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => setPickInfo(null)} disabled={busy}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={handleRestoreFile}
                      disabled={busy || confirmText !== pickInfo.inspect.name}
                    >
                      {busy ? "Restoring…" : "Restore this backup"}
                    </button>
                  </div>
                </>
              ) : (
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setPickInfo(null)}>
                    Close
                  </button>
                </div>
              )}
            </div>
          </div>
        </Modal>
      ) : null}

      {/* Existing per-row restore of a default-folder backup — unchanged */}
      {restoreTarget ? (
        <Modal open onClose={() => !busy && setRestoreTarget(null)}>
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Restore ${restoreTarget.name}`}>
            <div className="modal">
              <h2>Restore {restoreTarget.name}?</h2>
              <p>
                This replaces the current database contents with the selected backup. A safety backup of the current
                database is created first. This cannot be undone except by restoring the safety backup.
              </p>
              <p className="mb-2">
                Type <strong>{restoreTarget.name}</strong> to confirm.
              </p>
              <label>
                Type the backup file name to confirm
                <input
                  value={confirmText}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmText(e.target.value)}
                  placeholder={restoreTarget.name}
                  autoFocus
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setRestoreTarget(null)} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={handleRestore}
                  disabled={busy || confirmText !== restoreTarget.name}
                >
                  {busy ? "Restoring…" : "Restore backup"}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

function InfoRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: "0.5rem", padding: "0.125rem 0" }}>
      <dt className="text-muted" style={{ width: "6.5rem", flexShrink: 0 }}>{k}</dt>
      <dd style={{ margin: 0, wordBreak: "break-all" }}>{children}</dd>
    </div>
  );
}
