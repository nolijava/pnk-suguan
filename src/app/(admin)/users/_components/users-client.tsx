"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { StatusBadge } from "@/app/(admin)/_components";

/* Controlled field (label + input/select); matches the .field markup used by
   the other client editors (FormField is the uncontrolled server-form variant). */
function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>
        {label}
        {required ? <em aria-hidden="true"> *</em> : null}
      </span>
      {children}
    </label>
  );
}
import type { UserListRow } from "@/server/services/user-management.service";

const ROLE_OPTIONS = [
  { value: "ADMIN", label: "ADMINISTRATOR" },
  { value: "SCHEDULER", label: "SCHEDULER / ENCODER" },
  { value: "VIEWER", label: "VIEWER" },
];

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "ADMINISTRATOR",
  SCHEDULER: "SCHEDULER / ENCODER",
  VIEWER: "VIEWER",
  SUPER_ADMIN: "SUPER_ADMIN",
};

interface Props {
  initialRows: UserListRow[];
  filters: { q: string; role: string; status: string };
  currentUserId: string;
  currentUserRoles: string[];
}

type Dialog =
  | { kind: "create" }
  | { kind: "edit"; row: UserListRow }
  | { kind: "role"; row: UserListRow }
  | { kind: "status"; row: UserListRow; next: "ACTIVE" | "INACTIVE" }
  | { kind: "reset"; row: UserListRow }
  | { kind: "temp"; email: string; temp: string }
  | null;

export function UsersClient({ initialRows, filters, currentUserId, currentUserRoles }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<UserListRow[]>(initialRows);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();

  /* form state */
  const [q, setQ] = useState(filters.q);
  const [create, setCreate] = useState({ email: "", fullName: "", password: "", roleCode: "VIEWER" });
  const [editName, setEditName] = useState("");
  const [roleChoice, setRoleChoice] = useState("VIEWER");
  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");

  const isSuperAdmin = currentUserRoles.includes("SUPER_ADMIN");

  function applyRow(updated: UserListRow) {
    setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
    startTransition(() => router.refresh());
  }

  async function call(fn: () => Promise<Response>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      const body = (await res.json()) as { data?: unknown; error?: { message?: string } };
      if (!res.ok) {
        setError(body.error?.message ?? "Request failed.");
        return null;
      }
      return body.data;
    } catch {
      setError("Network error — please retry.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function refreshList(next: { q?: string; role?: string; status?: string }) {
    const params = new URLSearchParams();
    if (next.q) params.set("q", next.q);
    if (next.role) params.set("role", next.role);
    if (next.status) params.set("status", next.status);
    const data = await call(() => fetch(`/api/users?${params.toString()}`));
    if (data) setRows(data as UserListRow[]);
  }

  /* ---------------- actions ---------------- */

  async function submitCreate() {
    const data = (await call(() =>
      fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(create),
      }),
    )) as { id?: string } | null;
    if (data?.id) {
      setDialog({ kind: "temp", email: create.email, temp: create.password });
      setCreate({ email: "", fullName: "", password: "", roleCode: "VIEWER" });
      await refreshList({});
      startTransition(() => router.refresh());
    }
  }

  async function submitEdit() {
    if (!dialog || dialog.kind !== "edit") return;
    const data = (await call(() =>
      fetch(`/api/users/${dialog.row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "profile", fullName: editName }),
      }),
    )) as UserListRow | null;
    if (data) {
      applyRow(data);
      setDialog(null);
    }
  }

  async function submitRole() {
    if (!dialog || dialog.kind !== "role") return;
    const data = (await call(() =>
      fetch(`/api/users/${dialog.row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "role", roleCode: roleChoice, reason: reason || undefined }),
      }),
    )) as UserListRow | null;
    if (data) {
      applyRow(data);
      setDialog(null);
      setReason("");
    }
  }

  async function submitStatus(next: "ACTIVE" | "INACTIVE") {
    if (!dialog || dialog.kind !== "status") return;
    const data = (await call(() =>
      fetch(`/api/users/${dialog.row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", status: next, reason: reason || undefined }),
      }),
    )) as UserListRow | null;
    if (data) {
      applyRow(data);
      setDialog(null);
      setReason("");
      setConfirmText("");
    }
  }

  /** Reactivation is low-risk and needs no typed confirmation dialog. */
  async function submitReactivate(row: UserListRow) {
    const data = (await call(() =>
      fetch(`/api/users/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", status: "ACTIVE" }),
      }),
    )) as UserListRow | null;
    if (data) applyRow(data);
  }

  async function submitReset(row: UserListRow) {
    const data = (await call(() =>
      fetch(`/api/users/${row.id}/reset-password`, { method: "POST" }),
    )) as { temporaryPassword?: string } | null;
    if (data?.temporaryPassword) {
      setDialog({ kind: "temp", email: row.email, temp: data.temporaryPassword });
    }
  }

  const filterDirty =
    q !== filters.q || filters.role !== "" || filters.status !== "";

  return (
    <>
      <div className="page-header">
        <div>
          <h1>User Management</h1>
          <p>Accounts, roles, and access for the PNK Suguan System.</p>
        </div>
        <div className="page-header-actions">
          <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "create" })}>
            + Create User
          </button>
        </div>
      </div>

      {error ? (
        <div className="error-note" role="alert">
          {error}
        </div>
      ) : null}

      <div className="toolbar">
        <form
          className="toolbar-form"
          onSubmit={(e) => {
            e.preventDefault();
            void refreshList({ q });
          }}
        >
          <Field label="Search users">
            <input
              type="search"
              value={q}
              placeholder="Email or full name…"
              onChange={(e) => setQ(e.target.value)}
            />
          </Field>
          <Field label="Role">
            <select
              value={filters.role}
              onChange={(e) => void refreshList({ q, role: e.target.value, status: filters.status })}
            >
              <option value="">All roles</option>
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              value={filters.status}
              onChange={(e) => void refreshList({ q, role: filters.role, status: e.target.value })}
            >
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </Field>
          <button type="submit" className="btn btn-secondary" disabled={busy}>
            Search
          </button>
          {filterDirty ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setQ("");
                void refreshList({});
              }}
            >
              Reset
            </button>
          ) : null}
        </form>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last Login</th>
              <th>Created</th>
              <th className="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state">No users match the current filters.</div>
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isSelf = row.id === currentUserId;
                const protectedRow = row.roleCodes.includes("SUPER_ADMIN") && !isSuperAdmin;
                return (
                  <tr key={row.id}>
                    <td data-label="User">{row.fullName}</td>
                    <td data-label="Email">{row.email}</td>
                    <td data-label="Role">
                      {row.roleCodes.map((c) => ROLE_LABEL[c] ?? c).join(", ") || "—"}
                    </td>
                    <td data-label="Status">
                      <StatusBadge status={row.status} />
                      {row.mustChangePassword ? (
                        <span className="badge badge-amber" style={{ marginLeft: 6 }}>
                          TEMP PASSWORD
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Last Login">
                      {row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : "—"}
                    </td>
                    <td data-label="Created">{new Date(row.createdAt).toLocaleDateString()}</td>
                    <td className="actions-col">
                      <div className="actions-row" style={{ margin: 0, flexWrap: "wrap", gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={busy || protectedRow}
                          title={protectedRow ? "Protected account." : undefined}
                          onClick={() => {
                            setEditName(row.fullName);
                            setDialog({ kind: "edit", row });
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={busy || isSelf || protectedRow}
                          title={isSelf ? "You cannot change your own role." : protectedRow ? "Protected account." : undefined}
                          onClick={() => {
                            setRoleChoice(row.roleCodes[0] ?? "VIEWER");
                            setDialog({ kind: "role", row });
                          }}
                        >
                          Change Role
                        </button>
                        {row.status === "ACTIVE" ? (
                          <button
                            type="button"
                            className="btn btn-danger"
                            disabled={busy || isSelf || protectedRow}
                            title={isSelf ? "You cannot deactivate your own account." : protectedRow ? "Protected account." : undefined}
                            onClick={() => {
                              setConfirmText("");
                              setDialog({ kind: "status", row, next: "INACTIVE" });
                            }}
                          >
                            Deactivate
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy || protectedRow}
                            onClick={() => void submitReactivate(row)}
                          >
                            Reactivate
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={busy || protectedRow}
                          title={protectedRow ? "Protected account." : undefined}
                          onClick={() => void submitReset(row)}
                        >
                          Reset Password
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {pending ? <p className="muted" style={{ fontSize: 12 }}>Syncing…</p> : null}

      {/* ---------------- dialogs ---------------- */}

      {dialog?.kind === "create" ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setDialog(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="create-user-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="create-user-title">Create User</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              The account starts with a temporary password; the user must change it at first login.
            </p>
            <div className="form-col">
              <Field label="Email" required>
                <input
                  type="email"
                  value={create.email}
                  autoComplete="off"
                  onChange={(e) => setCreate({ ...create, email: e.target.value })}
                />
              </Field>
              <Field label="Full name" required>
                <input
                  value={create.fullName}
                  onChange={(e) => setCreate({ ...create, fullName: e.target.value })}
                />
              </Field>
              <Field label="Temporary password" required>
                <input
                  type="text"
                  value={create.password}
                  autoComplete="off"
                  onChange={(e) => setCreate({ ...create, password: e.target.value })}
                />
              </Field>
              <Field label="Role">
                <select value={create.roleCode} onChange={(e) => setCreate({ ...create, roleCode: e.target.value })}>
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void submitCreate()} disabled={busy || !create.email || !create.fullName || !create.password}>
                Create User
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog?.kind === "edit" ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setDialog(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-user-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="edit-user-title">Edit User</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              {dialog.row.email}
            </p>
            <div className="form-col">
              <Field label="Full name" required>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} />
              </Field>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void submitEdit()} disabled={busy || !editName.trim()}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog?.kind === "role" ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setDialog(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="role-user-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="role-user-title">Change User Role?</h3>
            <p>
              <strong>{dialog.row.fullName}</strong> ({dialog.row.email})
            </p>
            <p className="muted" style={{ fontSize: 13 }}>
              Current role: <strong>{dialog.row.roleCodes.map((c) => ROLE_LABEL[c] ?? c).join(", ") || "—"}</strong>
            </p>
            <div className="form-col">
              <Field label="New role">
                <select value={roleChoice} onChange={(e) => setRoleChoice(e.target.value)}>
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reason (recorded in the audit log)">
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this changing?" />
              </Field>
            </div>
            <p className="muted" style={{ fontSize: 12.5 }}>
              This immediately changes the permissions available to this account.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void submitRole()} disabled={busy}>
                Confirm Change
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog?.kind === "status" && dialog.next === "INACTIVE" ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setDialog(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="status-user-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="status-user-title">Deactivate User?</h3>
            <p>
              <strong>{dialog.row.fullName}</strong> ({dialog.row.email}) will immediately lose access.
              All active sessions are signed out. Historical audit records remain attributed to this account.
            </p>
            <div className="form-col">
              <Field label="Reason (recorded in the audit log)">
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this account being deactivated?" />
              </Field>
              <Field label="Type DEACTIVATE to confirm" required>
                <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
              </Field>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void submitStatus("INACTIVE")}
                disabled={busy || confirmText !== "DEACTIVATE"}
              >
                Deactivate
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog?.kind === "temp" ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setDialog(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="temp-user-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="temp-user-title">Temporary password</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              For <strong>{dialog.email}</strong>. Shown only once — copy it now and share it through a
              safe channel. The user must change it at first login.
            </p>
            <div className="success-note" style={{ fontSize: 15, letterSpacing: "0.03em", userSelect: "all" }}>
              {dialog.temp}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void navigator.clipboard?.writeText(dialog.temp)}
              >
                Copy
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setDialog(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
