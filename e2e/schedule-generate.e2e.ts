/**
 * Weekly Schedule generation-modal smoke — Update #22 §4-§8:
 *
 *  - "Generate schedule" opens a generation-method modal in the same style as
 *    the dashboard modal but with ONLY Auto-generate / Assign Destinado /
 *    Assign Katuwang — Manual is not offered and there is NO ISO-week field
 *    (the week the page displays IS the target week);
 *  - the server-side Weekly Availability gate blocks generation for a week whose
 *    availability is not encoded, with the same "Weekly Availability Required"
 *    notice and Go to Weekly Availability action;
 *  - a successful run never switches the page's selected ISO week.
 */
import { test, expect } from "@playwright/test";
import { isoWeek, isoWeekStart } from "../src/lib/iso-week";

const CURRENT = isoWeek(new Date());
const NEXT_START = isoWeekStart(CURRENT.year, CURRENT.week);
NEXT_START.setUTCDate(NEXT_START.getUTCDate() + 7);
const NEXT = isoWeek(NEXT_START);
/** A week of THIS ISO year the seed deliberately leaves without availability. */
const UNENCODED_WEEK = [1, 2, 3].find((w) => w !== CURRENT.week && w !== NEXT.week)!;

const generateButton = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: /Generate schedule|Regenerate schedule/ });

test.describe("Weekly Schedule generation modal", () => {
  test("offers exactly the three methods — no Manual, no ISO-week field", async ({ page }) => {
    await page.goto(`/schedule?year=${CURRENT.year}&week=${CURRENT.week}`);
    await generateButton(page).click();
    const dialog = page.getByRole("dialog", { name: "Generate Schedule" });
    await expect(dialog).toBeVisible();

    // The question of §6, and exactly ONE control — the method select.
    await expect(dialog).toContainText("How would you like to generate the weekly Suguan?");
    await expect(dialog.getByRole("combobox")).toHaveCount(1);
    const methods = await dialog
      .getByRole("combobox")
      .locator("option")
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    expect(methods).toEqual(["auto", "destinado", "katuwang"]); // Manual is NOT offered
    expect(methods).not.toContain("manual");

    // No ISO-week selector is duplicated inside this modal (§6).
    await expect(dialog.getByLabel("ISO WEEK")).toHaveCount(0);
    // The page's week is the target, shown read-only.
    await expect(dialog).toContainText(`ISO Week ${CURRENT.week} — ${CURRENT.year}`);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("blocks generation when the page's week has no availability", async ({ page }) => {
    await page.goto(`/schedule?year=${CURRENT.year}&week=${UNENCODED_WEEK}`);
    await expect(page.locator(".week-title")).toContainText(`Week ${UNENCODED_WEEK} · ${CURRENT.year}`);

    await generateButton(page).click();
    const dialog = page.getByRole("dialog", { name: "Generate Schedule" });
    await dialog.getByRole("button", { name: "Confirm" }).click();

    const notice = dialog.getByRole("alert");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Weekly Availability Required");
    await expect(notice).toContainText(/Weekly Availability has not been set/);
    await expect(notice).toContainText(`ISO Week ${UNENCODED_WEEK}, ${CURRENT.year}`);
    // Update #24 — the action lands in “fix availability” mode.
    await expect(notice.getByRole("link", { name: "Go to Weekly Availability" })).toHaveAttribute(
      "href",
      `/availability?year=${CURRENT.year}&week=${UNENCODED_WEEK}&fix=1`,
    );

    // The page's selected week never changes because of a blocked attempt.
    await expect(page.locator(".week-title")).toContainText(`Week ${UNENCODED_WEEK} · ${CURRENT.year}`);
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("generates for the page's selected week without switching it", async ({ page }) => {
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    await page.goto(`/schedule?year=${CURRENT.year}&week=${CURRENT.week}`);
    await expect(page.locator(".week-title")).toContainText(`Week ${CURRENT.week}`);
    const before = normalize(await page.locator(".week-title").innerText());

    await generateButton(page).click();
    const dialog = page.getByRole("dialog", { name: "Generate Schedule" });
    await dialog.getByRole("combobox").selectOption("katuwang");
    await dialog.getByRole("button", { name: "Confirm" }).click();

    // Generation reloads the page; the same ISO week must still be on screen.
    await expect
      .poll(async () => normalize(await page.locator(".week-title").innerText()))
      .toBe(before);
    await expect(page).toHaveURL(
      new RegExp(`/schedule\\?year=${CURRENT.year}&week=${CURRENT.week}`),
    );
    await expect(page.locator(".week-title")).toContainText(`Week ${CURRENT.week} · ${CURRENT.year}`);

    // The engine really ran: the SUGO section now lists generated (AUTO) rows.
    const sugo = page.locator(".sched-section").first();
    await expect(sugo).toContainText("SUGO");
    await expect(sugo.locator("tbody tr")).not.toHaveCount(0);
  });
});
