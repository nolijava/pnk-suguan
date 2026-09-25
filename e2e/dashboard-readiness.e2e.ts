/**
 * Update #23 — the Annual matrix shows each ISO week's Weekly Availability
 * readiness BEFORE generation is attempted.
 *
 * The e2e seed encodes availability for the CURRENT ISO week (and the NEXT one
 * when it shares the ISO year) and deliberately leaves every other week
 * unencoded, so both states are guaranteed to be on screen:
 *
 *  - every week column carries exactly one mark, in all three tables;
 *  - a seeded week is READY (filled dot) and links to its own Weekly
 *    Availability;
 *  - an unencoded week is BLOCKED (ring, i.e. a different SHAPE — never colour
 *    alone) with the exact missing count in its accessible name and tooltip,
 *    and it deep-links into “fix availability” mode (Update #24: `fix=1`);
 *  - the legend explains the marks.
 */
import { test, expect } from "@playwright/test";
import { isoWeek, isoWeeksInYear, isoWeekStart } from "../src/lib/iso-week";

const CURRENT = isoWeek(new Date());
const WEEKS_IN_YEAR = isoWeeksInYear(CURRENT.year);
const NEXT_START = isoWeekStart(CURRENT.year, CURRENT.week);
NEXT_START.setUTCDate(NEXT_START.getUTCDate() + 7);
const NEXT = isoWeek(NEXT_START);
/** The weeks the seed encoded — ready on the dashboard. */
const READY_WEEKS = [CURRENT.week, ...(NEXT.year === CURRENT.year ? [NEXT.week] : [])];
/** A week of THIS year the seed deliberately leaves without availability. */
const UNENCODED_WEEK = [1, 2, 3].find((w) => !READY_WEEKS.includes(w))!;

test.describe("Annual matrix — weekly availability readiness", () => {
  test("marks ready and blocked weeks before generation is attempted", async ({ page }) => {
    await page.goto("/");

    const tables = page.locator(".annual-table");
    await expect(tables).toHaveCount(3);

    // One mark per ISO-week column, in every one of the three tables.
    await expect(page.locator(".annual-table thead .week-ready")).toHaveCount(WEEKS_IN_YEAR * 3);

    const sugo = tables.first();
    const headerOf = (w: number) =>
      sugo.locator("thead th").filter({ hasText: `W${String(w).padStart(2, "0")}` });

    // ---- a week the seed encoded is READY, and says so exactly -------------
    const readyHeader = headerOf(CURRENT.week);
    const readyDot = readyHeader.locator(".week-ready");
    await expect(readyDot).toHaveClass(/is-ready/);
    await expect(readyDot).not.toHaveClass(/is-blocked/);
    const readyLink = readyHeader.locator(".week-ready-link");
    await expect(readyLink).toHaveAttribute(
      "href",
      `/availability?year=${CURRENT.year}&week=${CURRENT.week}`,
    );
    const readyLabel = await readyLink.getAttribute("aria-label");
    expect(readyLabel).toContain("availability ready");
    expect(readyLabel).toMatch(/all \d+ required teachers are encoded/);
    await expect(readyLink).toHaveAttribute("title", readyLabel ?? "");

    // ---- a week the seed left unencoded is BLOCKED -------------------------
    const blockedHeader = headerOf(UNENCODED_WEEK);
    const blockedDot = blockedHeader.locator(".week-ready");
    await expect(blockedDot).toHaveClass(/is-blocked/);
    const blockedLink = blockedHeader.locator(".week-ready-link");
    // Update #24 — a blocked week opens the fix-availability guide directly.
    await expect(blockedLink).toHaveAttribute(
      "href",
      `/availability?year=${CURRENT.year}&week=${UNENCODED_WEEK}&fix=1`,
    );
    await expect(blockedLink).toHaveClass(/is-fix/);
    const blockedLabel = await blockedLink.getAttribute("aria-label");
    expect(blockedLabel).toContain("generation is blocked");
    expect(blockedLabel).toMatch(/missing for \d+ of \d+ required teachers/);
    expect(blockedLabel).toContain("Click to fix availability");
    await expect(blockedLink).toHaveAttribute("title", blockedLabel ?? "");

    // A ready week is not a fix target.
    const readyHref = await readyLink.getAttribute("href");
    expect(readyHref).not.toContain("fix=");

    // Meaning is never colour alone: the blocked dot is a different SHAPE
    // (transparent fill + ring) from the ready dot, not merely another hue.
    const readyBg = await readyDot.evaluate((el) => getComputedStyle(el).backgroundColor);
    const blockedBg = await blockedDot.evaluate((el) => getComputedStyle(el).backgroundColor);
    const blockedRing = await blockedDot.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(blockedBg).not.toBe(readyBg);
    expect(blockedRing).not.toBe("none");

    // ---- the legend explains the marks -------------------------------------
    const legend = page.locator(".week-readiness-legend");
    await expect(legend).toBeVisible();
    await expect(legend).toContainText("Availability ready");
    await expect(legend).toContainText("generation blocked");
  });
});
