/**
 * Shared paths for the Playwright smoke suite.
 *
 * Everything the suite writes (backups, dialog picks, auth state) lives OUTSIDE
 * the operator's real data areas: the dev server is steered at these sandboxes
 * via PNK_BACKUP_DIR / PNK_DIALOG_STUB_FILE (see playwright.config.ts), so a
 * test run can never touch `%LOCALAPPDATA%\PNK Suguan\backups` or the live
 * preview database.
 */
import os from "node:os";
import path from "node:path";

export const E2E_PORT = 3210;
export const BASE_URL = `http://localhost:${E2E_PORT}`;

export const SANDBOX = path.join(os.tmpdir(), "pnk-suguan-e2e");
/** Sandboxed "default backup directory" the e2e server dumps into. */
export const BACKUP_DIR = path.join(SANDBOX, "backups");
/** Destination folder for "Choose Different Location" picks. */
export const CUSTOM_DIR = path.join(SANDBOX, "custom");
/** File-based dialog stub seam (native-dialog.service.ts) — one pick per write. */
export const DIALOG_STUB_FILE = path.join(SANDBOX, "dialog-stub.txt");
/** Saved session for the smoke specs (auth.setup.ts). */
export const AUTH_STATE = path.join(process.cwd(), "e2e", ".auth", "state.json");

/** The TEST database only — the suite never points at the live database. */
export const TEST_DB_URL =
  process.env.PNK_TEST_DATABASE_URL ?? "postgresql://pnk:pnk@127.0.0.1:5434/pnk_test";

/** Login of the seeded operator (e2e/seed.ts → tests/int/helpers seedAdmin). */
export const E2E_EMAIL = "admin@test.local";
export const E2E_PASSWORD = "TestAdminPass1!";

/**
 * The seeded READ-ONLY account (e2e/seed.ts → tests/int/helpers seedViewer),
 * used to prove the navigation hides what a role may not reach.
 */
export const VIEWER_EMAIL = "viewer@test.local";
export const VIEWER_PASSWORD = "TestViewerPass1!";
