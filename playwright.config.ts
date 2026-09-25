/**
 * Playwright smoke suite — drives the key UI flows (login, teacher form
 * validation + confirmation modals, Generate Suguan modal, backup location
 * dialogs) against a REAL dev server and REAL database.
 *
 * Isolation rules:
 *  - Its own `next dev` on port 3210 with PNK_DIST_DIR=.next-e2e, so the
 *    developer's running server (and its .next) is never clobbered.
 *  - DATABASE_URL points at the TEST database (pnk_test) — the live preview
 *    database is untouched. e2e/seed.ts resets/seeds it on every run.
 *  - PNK_BACKUP_DIR / PNK_DIALOG_STUB_FILE sandbox the backup output and stub
 *    the native Windows dialogs (file-based seam in native-dialog.service.ts),
 *    so no real OS dialog can block an automated run and no test backup lands
 *    in the operator's real backups folder.
 *
 * Files are named `*.e2e.ts` on purpose: vitest's default globs (`*.test.ts` /
 * `*.spec.ts`) never collect them, and testMatch below selects exactly them.
 * The destructive restore is intentionally never executed here — it is
 * covered end-to-end by tests/int/backup.test.ts instead.
 */
import { defineConfig, devices } from "@playwright/test";
import { AUTH_STATE, BACKUP_DIR, BASE_URL, DIALOG_STUB_FILE, E2E_PORT, TEST_DB_URL } from "./e2e/paths";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    channel: "chrome", // system Google Chrome — the Playwright CDN is unreachable from this machine
    trace: "retain-on-failure",
    actionTimeout: 20_000,
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts$/ },
    {
      name: "smoke",
      testMatch: /.*\.e2e\.ts$/,
      dependencies: ["setup"],
      // The session the setup project captured through the real login form.
      use: { ...devices["Desktop Chrome"], channel: "chrome", storageState: AUTH_STATE },
    },
  ],
  webServer: {
    command: `npx tsx e2e/seed.ts && npx next dev -p ${E2E_PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      DATABASE_URL: TEST_DB_URL,
      PNK_BACKUP_DIR: BACKUP_DIR,
      PNK_DIALOG_STUB_FILE: DIALOG_STUB_FILE,
      PNK_DIST_DIR: ".next-e2e",
    },
  },
});
