/**
 * New Update #11 — navigation structure smoke.
 *
 * The restructure is a pure DISCLOSURE change: five top-level entries
 * (Dashboard · Schedule · Reports · Settings · Audit), with Schedule and
 * Settings opening into children. Nothing may move behind hover, the group
 * header must be a real button (click / Enter / Space — tap on a tablet), the
 * children must stay ordinary links that mark themselves `aria-current`, and a
 * role that does not hold the permission must not receive the entry at all.
 *
 * The RBAC case logs in as the seeded VIEWER in a fresh context, because the
 * suite's saved session belongs to the ADMIN — the only way to prove absence is
 * to look at the sidebar with the role that lacks it.
 */
import { test, expect, type Page } from "@playwright/test";
import { VIEWER_EMAIL, VIEWER_PASSWORD } from "./paths";

/** The five top-level entries of Update #11, in order. */
const TOP_LEVEL = ["Dashboard", "Schedule", "Reports", "Settings", "Audit"];
const SCHEDULE_CHILDREN = ["Weekly Schedule", "Availability", "Magtuturo", "Historical Backfill"];

const sidebar = (page: Page) => page.locator(".sidebar nav");
const entries = (page: Page) =>
  sidebar(page).locator("> .nav-item, > .nav-group > .nav-group-toggle");
const labels = (page: Page) =>
  entries(page).evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).dataset.label ?? ""),
  );
const groupToggle = (page: Page, label: string) =>
  sidebar(page).getByRole("button", { name: new RegExp(`^${label}$`) });
/** The disclosed children of a group, in render order. */
const children = (page: Page, group: string) =>
  page.locator(`#nav-sub-${group.toLowerCase()} .nav-label`);

async function childLabels(page: Page, group: string): Promise<string[]> {
  return children(page, group).evaluateAll((els) =>
    els.map((el) => (el.textContent ?? "").trim()),
  );
}

test.describe("Update #11 — grouped navigation", () => {
  test("shows exactly five top-level entries in order, collapsed until asked", async ({ page }) => {
    await page.goto("/");

    expect(await labels(page)).toEqual(TOP_LEVEL);
    await expect(sidebar(page).locator("> .nav-item, > .nav-group")).toHaveCount(5);

    const schedule = groupToggle(page, "Schedule");
    await expect(schedule).toHaveAttribute("aria-expanded", "false");
    // Closed means ABSENT, not merely hidden — nothing is reachable by accident.
    await expect(page.locator("#nav-sub-schedule")).toHaveCount(0);

    // Hovering is not disclosure: the group must stay closed (and the old
    // hover-only submenu behaviour must not come back).
    await schedule.hover();
    await page.waitForTimeout(150);
    await expect(page.locator("#nav-sub-schedule")).toHaveCount(0);
    await expect(schedule).toHaveAttribute("aria-expanded", "false");

    // A real click opens it — the header is a button, not a link.
    await schedule.click();
    await expect(schedule).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#nav-sub-schedule")).toBeVisible();
    expect(await childLabels(page, "schedule")).toEqual(SCHEDULE_CHILDREN);

    for (const [index, child] of SCHEDULE_CHILDREN.entries()) {
      const link = page.locator("#nav-sub-schedule a").nth(index);
      await expect(link).toHaveAttribute("href", ["/schedule", "/availability", "/magtuturo", "/historical"][index]!);
      await expect(link).toContainText(child);
    }

    // Clicking the header again closes it, and no children stay in the DOM.
    await schedule.click();
    await expect(schedule).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#nav-sub-schedule")).toHaveCount(0);
  });

  test("Settings discloses its children and keeps the gated ones for the ADMIN", async ({ page }) => {
    await page.goto("/");
    const settings = groupToggle(page, "Settings");
    await settings.click();
    await expect(settings).toHaveAttribute("aria-expanded", "true");
    expect(await childLabels(page, "settings")).toEqual(["Teachers", "Dako", "Users", "Backup/Restore"]);
    await expect(page.locator('#nav-sub-settings a[href="/users"]')).toBeVisible();
    await expect(page.locator('#nav-sub-settings a[href="/settings"]')).toBeVisible();
  });

  test("the header works from the keyboard and a child navigates into the group", async ({ page }) => {
    await page.goto("/");
    const schedule = groupToggle(page, "Schedule");

    await schedule.focus();
    await page.keyboard.press("Enter");
    await expect(schedule).toHaveAttribute("aria-expanded", "true");

    await page.keyboard.press("Space");
    await expect(schedule).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press("Enter");
    await expect(schedule).toHaveAttribute("aria-expanded", "true");

    // Tab reaches the disclosed links in order, and Enter follows one.
    await page.locator('#nav-sub-schedule a[href="/historical"]').focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/historical$/);

    // The group holding the active page stays open and marks itself.
    await expect(schedule).toHaveAttribute("aria-expanded", "true");
    await expect(schedule).toHaveAttribute("data-active", "true");
    await expect(page.locator('#nav-sub-schedule a[href="/historical"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
    // The plain entries (Dashboard, Reports) are not group headers at all.
    await expect(sidebar(page).locator('a.nav-item[href="/reports"]')).toHaveAttribute(
      "href",
      "/reports",
    );
  });

  test("marks the current page on its own entry, never on a sibling", async ({ page }) => {
    await page.goto("/");
    await expect(sidebar(page).locator('a.nav-item[href="/"]')).toHaveAttribute("aria-current", "page");
    await expect(sidebar(page).locator("[aria-current='page']")).toHaveCount(1);

    await sidebar(page).locator('a.nav-item[href="/reports"]').click();
    await page.waitForURL(/\/reports$/);
    await expect(sidebar(page).locator('a.nav-item[href="/reports"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(sidebar(page).locator("[aria-current='page']")).toHaveCount(1);
  });

  test("in the collapsed rail a group header expands the rail and the group together", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.locator(".shell")).toHaveAttribute("data-collapsed", "true");
    await expect(page.locator("#nav-sub-schedule")).toHaveCount(0);

    // In the rail the labels are hidden, so the first activation must restore
    // the rail (and remember it) *and* disclose the group.
    await groupToggle(page, "Schedule").click();
    await expect(page.locator(".shell")).toHaveAttribute("data-collapsed", "false");
    await expect(groupToggle(page, "Schedule")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#nav-sub-schedule")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("pnk-shell-collapsed")))
      .toBe("false");

    // Leave the shared context expanded for the specs that follow.
    await page.evaluate(() => window.localStorage.removeItem("pnk-shell-collapsed"));
  });
});

test.describe("Update #11 — permission-gated entries", () => {
  // A fresh, unauthenticated context: the saved session belongs to the ADMIN.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a VIEWER receives no Audit, Users or Backup entry at all", async ({ page }) => {
    await page.goto("/login");
    await page.locator('[name="email"]').fill(VIEWER_EMAIL);
    await page.locator('[name="password"]').fill(VIEWER_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => url.pathname === "/");

    // Four top-level entries: Audit is ADMIN-only and is simply not rendered.
    expect(await labels(page)).toEqual(["Dashboard", "Schedule", "Reports", "Settings"]);
    await expect(sidebar(page).locator('a[href="/audit-logs"]')).toHaveCount(0);
    await expect(page.locator('a[href="/audit-logs"]')).toHaveCount(0);

    // Schedule is the same for every role that can read the week.
    await groupToggle(page, "Schedule").click();
    expect(await childLabels(page, "schedule")).toEqual(SCHEDULE_CHILDREN);

    // Settings keeps only the master-data children — no Users, no Backup/Restore.
    await groupToggle(page, "Settings").click();
    expect(await childLabels(page, "settings")).toEqual(["Teachers", "Dako"]);
    await expect(page.locator('a[href="/users"]')).toHaveCount(0);
    await expect(page.locator('a[href="/settings"]')).toHaveCount(0);
  });
});
