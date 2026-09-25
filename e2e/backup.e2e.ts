/**
 * Backup / Restore UI smoke — the Update-18+ location flows end-to-end:
 * location-choice modal, Default Location and Choose Different Location
 * creates (regressions: real filename in the message — never "undefined" —
 * and the list refreshes itself), a failing destination reported as failure
 * with no misleading success, and both restore dialogs behind their strong
 * typed confirmations.
 *
 * The native Windows dialogs are stubbed through the file-based seam
 * (PNK_DIALOG_STUB_FILE) — one simulated pick per test. The DESTRUCTIVE
 * restore is intentionally never executed here (it replaces the database and
 * restarts the app); the full pipeline is covered by tests/int/backup.test.ts.
 */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKUP_DIR, CUSTOM_DIR, DIALOG_STUB_FILE, SANDBOX, TEST_DB_URL } from "./paths";

/** The same portable PostgreSQL tools the app's backup service uses. */
const PG_BIN = path.join(process.cwd(), ".pg", "pgsql", "bin");
const VALID_DUMP = path.join(SANDBOX, "valid-backup.dump");
const GARBAGE_DUMP = path.join(SANDBOX, "garbage.dump");
const SEED_BACKUP = path.join(BACKUP_DIR, "e2e-seed-backup.dump");

function tool(name: string): string {
  return path.join(PG_BIN, process.platform === "win32" ? `${name}.exe` : name);
}

function pgToolEnv(): NodeJS.ProcessEnv {
  const u = new URL(TEST_DB_URL);
  return {
    ...process.env,
    PGHOST: u.hostname || "127.0.0.1",
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
    PGSSLMODE: "disable",
  };
}

/** Simulate the user's pick in the native dialog ("\"-free path, or "" = cancel). */
function setDialogPick(picked: string): void {
  writeFileSync(DIALOG_STUB_FILE, picked);
}

/** First five bytes — a real pg_dump archive starts with "PGDMP". */
function magic(file: string): string {
  return readFileSync(file).subarray(0, 5).toString("latin1");
}

test.beforeAll(() => {
  mkdirSync(BACKUP_DIR, { recursive: true });
  mkdirSync(CUSTOM_DIR, { recursive: true });
  // A REAL dump (the restore-from-file review needs a valid archive) …
  execFileSync(tool("pg_dump"), ["--format=custom", "--no-owner", "--no-privileges", `--file=${VALID_DUMP}`], {
    env: pgToolEnv(),
    timeout: 60_000,
    windowsHide: true,
  });
  // … a garbage ".dump" (untrusted input must be rejected) …
  writeFileSync(GARBAGE_DUMP, "this is not a PostgreSQL backup at all");
  // … and one backup already in the default directory for the list/row flows.
  copyFileSync(VALID_DUMP, SEED_BACKUP);
  setDialogPick("");
});

test.describe("Backup / Restore dialogs", () => {
  test("Create backup opens the location choice; Cancel creates nothing", async ({ page }) => {
    await page.goto("/settings");
    const rows = page.locator("section.card table tbody tr");
    const before = await rows.count();

    await page.getByRole("button", { name: "Create backup" }).first().click();
    const location = page.getByRole("dialog", { name: "Backup location" });
    await expect(location).toBeVisible();
    await expect(location).toContainText(BACKUP_DIR); // default destination shown
    await expect(location.getByRole("button", { name: "Default Location" })).toBeVisible();
    await expect(location.getByRole("button", { name: "Choose Different Location" })).toBeVisible();

    await location.getByRole("button", { name: "Cancel" }).click();
    await expect(location).toBeHidden();
    await expect(rows).toHaveCount(before); // nothing was created
  });

  test("Default Location creates a real, validated backup and refreshes the list", async ({ page }) => {
    await page.goto("/settings");
    const rows = page.locator("section.card table tbody tr");
    const before = await rows.count();

    await page.getByRole("button", { name: "Create backup" }).first().click();
    await page
      .getByRole("dialog", { name: "Backup location" })
      .getByRole("button", { name: "Default Location" })
      .click();

    const confirm = page.getByRole("dialog", { name: "Create backup" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(BACKUP_DIR); // destination shown before confirming
    await confirm.getByRole("button", { name: "Create backup" }).click();

    // Regression: the message must carry the REAL file name (the response
    // envelope once leaked "undefined" here) and the validation verdict.
    const message = page.locator("p.notice");
    await expect(message).toContainText(/Backup created: pnk-backup-[\w-]+\.dump/);
    await expect(message).toContainText("integrity verified");
    await expect(message).not.toContainText("undefined");
    const name = (await message.innerText()).match(/Backup created: (\S+\.dump)/)![1]!;

    // Regression: the server-side list refreshes itself after the create.
    await expect(confirm).toBeHidden();
    await expect(rows).toHaveCount(before + 1);
    await expect(rows.first()).toContainText(name);

    // A real pg_dump archive landed in the default directory.
    const file = path.join(BACKUP_DIR, name);
    expect(existsSync(file)).toBe(true);
    expect(magic(file)).toBe("PGDMP");
  });

  test("Choose Different Location writes the archive to the picked path", async ({ page }) => {
    const custom = path.join(CUSTOM_DIR, `e2e-custom-${Date.now()}.dump`);
    setDialogPick(custom);
    await page.goto("/settings");
    const rows = page.locator("section.card table tbody tr");
    const before = await rows.count();

    await page.getByRole("button", { name: "Create backup" }).first().click();
    await page
      .getByRole("dialog", { name: "Backup location" })
      .getByRole("button", { name: "Choose Different Location" })
      .click();

    const confirm = page.getByRole("dialog", { name: "Create backup" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(custom); // the CHOSEN destination is shown first
    await confirm.getByRole("button", { name: "Create backup" }).click();

    const message = page.locator("p.notice");
    await expect(message).toContainText("Backup created: e2e-custom-");
    await expect(message).not.toContainText("undefined");

    // The real archive is at the picked location …
    expect(existsSync(custom)).toBe(true);
    expect(magic(custom)).toBe("PGDMP");
    // … and is NOT silently copied into the default backup list.
    await expect(rows).toHaveCount(before);
  });

  test("an unwritable destination fails clearly and never reports success", async ({ page }) => {
    // Parent folder does not exist — the create must fail at validation.
    const bad = `C:\\pnk-e2e-missing-${Date.now()}\\fail.dump`;
    setDialogPick(bad);
    await page.goto("/settings");
    const rows = page.locator("section.card table tbody tr");
    const before = await rows.count();

    await page.getByRole("button", { name: "Create backup" }).first().click();
    await page
      .getByRole("dialog", { name: "Backup location" })
      .getByRole("button", { name: "Choose Different Location" })
      .click();
    const confirm = page.getByRole("dialog", { name: "Create backup" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Create backup" }).click();

    // Clear error, no misleading success record, no phantom row or file.
    await expect(page.locator("p.error")).toContainText("not an accessible folder");
    await expect(page.locator("p.notice")).toHaveCount(0);
    await expect(rows).toHaveCount(before);
    expect(existsSync(bad)).toBe(false);
  });

  test("Restore from file rejects an invalid file as untrusted input", async ({ page }) => {
    setDialogPick(GARBAGE_DUMP);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Restore from file…" }).click();

    const dialog = page.getByRole("dialog", { name: "Restore backup from file" });
    await expect(dialog).toBeVisible();
    // A .dump extension grants no trust — the PGDMP check names the problem …
    await expect(dialog).toContainText("not a PostgreSQL custom-format backup");
    // … and the destructive button does not even exist for an invalid file.
    await expect(dialog.getByRole("button", { name: "Restore this backup" })).toHaveCount(0);

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
  });

  test("Restore from file: a valid backup is reviewed behind a strong typed confirm", async ({ page }) => {
    setDialogPick(VALID_DUMP);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Restore from file…" }).click();

    const dialog = page.getByRole("dialog", { name: "Restore backup from file" });
    await expect(dialog).toContainText("Valid PostgreSQL backup");
    await expect(dialog).toContainText(/\d+ entries/);

    const restore = dialog.getByRole("button", { name: "Restore this backup" });
    await expect(restore).toBeDisabled(); // strong confirm gates the destructive step
    await dialog.locator("input").fill("valid-backup.dum");
    await expect(restore).toBeDisabled(); // near-miss is not confirmation
    await dialog.locator("input").fill("valid-backup.dump");
    await expect(restore).toBeEnabled();

    // The smoke suite never executes the destructive restore.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("per-row Restore… requires typing the exact file name", async ({ page }) => {
    await page.goto("/settings");
    const row = page.locator("section.card table tbody tr", { hasText: "e2e-seed-backup.dump" });
    await row.getByRole("button", { name: "Restore…" }).click();

    const dialog = page.getByRole("dialog", { name: "Restore e2e-seed-backup.dump" });
    await expect(dialog).toBeVisible();
    const restore = dialog.getByRole("button", { name: "Restore backup", exact: true });
    await expect(restore).toBeDisabled();
    await dialog.locator("input").fill("e2e-seed-backup.dump");
    await expect(restore).toBeEnabled();

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });
});
