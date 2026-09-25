import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { ValidationError } from "@/lib/errors";

const execFileAsync = promisify(execFile);

/**
 * Post-release update (Backup location options) — native Windows dialogs.
 *
 * PNK Suguan is a Windows local application: the trusted backend (this
 * process, started by the launcher in the user's interactive session) opens
 * the dialog via PowerShell + WinForms — the same "shell PowerShell" pattern
 * the launcher already uses. The browser NEVER touches the filesystem: it can
 * only ask the backend to open a picker and later reference the server-side
 * token of what the user chose.
 *
 * No new dependency: System.Windows.Forms ships with every Windows install.
 */

export interface PickedPath {
  /** null = the user cancelled the dialog. */
  path: string | null;
}

function assertDialogAvailable(): void {
  if (process.platform !== "win32") {
    throw new ValidationError("native file dialogs require Windows");
  }
  // Automated tests must never block on an interactive dialog.
  if (process.env.NODE_ENV === "test" && process.env.PNK_ALLOW_DIALOG_IN_TESTS !== "1") {
    throw new ValidationError("native file dialogs are not available in automated runs");
  }
}

async function runDialog(script: string, timeoutMs: number): Promise<string | null> {
  // Test-only seam (file-based): the Playwright suite varies the simulated pick
  // PER TEST by rewriting this file ("" = the user cancelled). Unset in
  // production — the real Windows dialog runs there.
  if (process.env.PNK_DIALOG_STUB_FILE !== undefined) {
    let fromFile = "";
    try {
      fromFile = readFileSync(process.env.PNK_DIALOG_STUB_FILE, "utf8").trim();
    } catch {
      fromFile = ""; // missing/empty stub file = the user cancelled
    }
    return fromFile.length > 0 ? fromFile : null;
  }
  // Test-only seam: simulate the user's pick ("" = cancelled) without an
  // interactive dialog, so the whole pick → token → backup chain is testable.
  // Unset in production — the real Windows dialog runs there.
  if (process.env.PNK_DIALOG_STUB !== undefined) {
    const stub = process.env.PNK_DIALOG_STUB.trim();
    return stub.length > 0 ? stub : null;
  }
  assertDialogAvailable();
  let stdout: string;
  try {
    // -STA: WinForms dialogs require a single-threaded apartment.
    ({ stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
      { timeout: timeoutMs, windowsHide: false, maxBuffer: 1024 * 1024 },
    ));
  } catch (err) {
    const e = err as { killed?: boolean; message?: string };
    if (e.killed) throw new ValidationError("the file dialog timed out");
    throw new ValidationError(`the file dialog failed: ${e.message ?? "unknown error"}`);
  }
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  return line.length > 0 ? line : null;
}

function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** "Save As" dialog for choosing a backup destination (folder + file name). */
export async function pickSavePath(opts: {
  defaultFileName: string;
  initialDir: string;
}): Promise<PickedPath> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dlg = New-Object System.Windows.Forms.SaveFileDialog",
    `$dlg.InitialDirectory = ${psq(opts.initialDir)}`,
    `$dlg.FileName = ${psq(opts.defaultFileName)}`,
    "$dlg.Filter = 'PostgreSQL backup (*.dump)|*.dump|All files (*.*)|*.*'",
    "$dlg.OverwritePrompt = $false",
    "$dlg.Title = 'Choose where to save the PNK Suguan backup'",
    "if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.FileName }",
  ].join("; ");
  return { path: await runDialog(script, 600_000) };
}

/** "Open" dialog for choosing a backup file to restore (any local location). */
export async function pickOpenFile(opts: { initialDir: string }): Promise<PickedPath> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dlg = New-Object System.Windows.Forms.OpenFileDialog",
    `$dlg.InitialDirectory = ${psq(opts.initialDir)}`,
    "$dlg.Filter = 'PostgreSQL backup (*.dump)|*.dump|All files (*.*)|*.*'",
    "$dlg.CheckFileExists = $true",
    "$dlg.Title = 'Choose a PNK Suguan backup file to restore'",
    "if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.FileName }",
  ].join("; ");
  return { path: await runDialog(script, 600_000) };
}
