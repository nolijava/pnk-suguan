/**
 * Update #24 — the “Fix availability” guide reached from a BLOCKED week.
 *
 * A blocked week's readiness mark (and the generation block notices) deep-link
 * to `/availability?year=&week=&fix=1`, which must:
 *
 *  - show the generation gate's OWN blocking sentence, naming the exact week;
 *  - highlight every teacher still blocking generation (master-ACTIVE with no
 *    row for the week) and say how many are hidden by the active filters;
 *  - offer the one-click fill — still behind its confirm dialog, never silent;
 *  - and then disappear by itself, because nothing is missing any more.
 *
 * The guide is opt-in: the ordinary week view (no `fix`) is unchanged.
 *
 * A FAR-FUTURE week is used on purpose. The suite runs serially against one
 * database, and every other spec relies on the seed encoding exactly the
 * current and next ISO weeks — so filling a 2099 week here cannot disturb them.
 */
import { test, expect } from "@playwright/test";

const FIX_YEAR = 2099;
const FIX_WEEK = 1;

test.describe("Fix availability guide", () => {
  test("highlights the teachers blocking generation and fills them in one click", async ({ page }) => {
    await page.goto(`/availability?year=${FIX_YEAR}&week=${FIX_WEEK}&fix=1`);

    // The guide carries the gate's own sentence — the same words that block
    // generation, so the page and the server can never disagree.
    const guide = page.locator(".block-notice.fix-availability");
    await expect(guide).toBeVisible();
    await expect(guide).toContainText("Weekly Availability Required");
    await expect(guide).toContainText(`ISO Week ${FIX_WEEK}, ${FIX_YEAR}`);
    await expect(guide).toContainText(/Weekly Availability has not been set/);
    await expect(guide).toContainText(/teacher\(s\) still missing/);

    // Every blocking teacher is highlighted and labelled in the grid.
    const highlighted = page.locator("tr.row-needs-availability");
    const blocking = await highlighted.count();
    expect(blocking).toBeGreaterThan(0);
    await expect(page.locator(".needs-availability-note")).toHaveCount(blocking);

    // The guide's count is the SERVER's count, and it is offered as one action.
    const fill = guide.getByRole("button", { name: `Fill ${blocking} as AVAILABLE` });
    await expect(fill).toBeVisible();

    // “Show only the missing” narrows the grid to those rows — and must keep
    // the WEEK (it carries filters, not navigation): a link that lost the week
    // would silently jump to today.
    const onlyMissing = guide.getByRole("link", { name: "Show only the missing" });
    const href = (await onlyMissing.getAttribute("href")) ?? "";
    const params = new URLSearchParams(href.split("?")[1] ?? "");
    expect(params.get("year")).toBe(String(FIX_YEAR));
    expect(params.get("week")).toBe(String(FIX_WEEK));
    expect(params.get("fix")).toBe("1");
    expect(params.get("availability")).toBe("NOT_ENCODED");

    // One click, but never silent: the existing confirm dialog still gates it.
    await fill.click();
    const dialog = page.getByRole("dialog", { name: "Fill blanks confirmation" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: `Create ${blocking} record(s)` }).click();

    await expect(page.getByText(new RegExp(`Created ${blocking} AVAILABLE record`))).toBeVisible();
    // Nothing is missing now, so the guide and the highlight remove themselves.
    await expect(page.locator(".block-notice.fix-availability")).toHaveCount(0);
    await expect(page.locator("tr.row-needs-availability")).toHaveCount(0);
  });

  test("keeps the guide (and the week) when a filter is applied", async ({ page }) => {
    await page.goto(`/availability?year=${FIX_YEAR}&week=3&fix=1`);
    const guide = page.locator(".block-notice.fix-availability");
    await expect(guide).toBeVisible();

    // Applying a filter goes through the query string, and the guide's own
    // parameter must survive it — otherwise the page would fall back to the
    // unfiltered view mid-remediation.
    await page.goto(`/availability?year=${FIX_YEAR}&week=3&fix=1&availability=NOT_ENCODED`);
    await expect(page.locator(".week-title")).toContainText(`Week 3 · ${FIX_YEAR}`);
    await expect(page.locator(".toolbar select[name='availability']")).toHaveValue("NOT_ENCODED");
    await expect(page.locator(".block-notice.fix-availability")).toBeVisible();
    await expect(page.locator("tr.row-needs-availability").first()).toBeVisible();
  });

  test("is opt-in: the plain week view still shows no guide and no highlight", async ({ page }) => {
    await page.goto(`/availability?year=${FIX_YEAR}&week=2`);

    await expect(page.locator(".week-title")).toContainText(`Week 2 · ${FIX_YEAR}`);
    await expect(page.locator(".block-notice.fix-availability")).toHaveCount(0);
    await expect(page.locator("tr.row-needs-availability")).toHaveCount(0);
    await expect(page.locator(".needs-availability-note")).toHaveCount(0);
    // The grid itself is still fully rendered — the guide is what is opt-in.
    await expect(page.locator(".avail-editor tbody tr").first()).toBeVisible();
  });
});
