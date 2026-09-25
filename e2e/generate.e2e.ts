/**
 * Generate Suguan modal smoke — Update #22 contract plus the Update #19 base:
 *
 *  - the modal carries an ISO WEEK selector (Week 1 … Week 52/53 of the current
 *    ISO year) AND the Generation Method, and both are submitted together;
 *  - the SELECTED week is the week actually generated;
 *  - the server-side Weekly Availability gate BLOCKS generation for a week whose
 *    availability is not encoded, showing the "Weekly Availability Required"
 *    notice with the Go to Weekly Availability action (the modal stays open);
 *  - Manual is gated too and then opens the selected week's schedule;
 *  - Assign Katuwang still runs end-to-end and the modal CLOSES on success with
 *    a message carrying real numbers (never "undefined");
 *  - the dashboard teacher name renders at 8pt with the middle name hidden and
 *    the suffix kept, badges intact.
 */
import { test, expect } from "@playwright/test";
import { isoWeek, isoWeeksInYear, isoWeekStart } from "../src/lib/iso-week";

const CURRENT = isoWeek(new Date());
const WEEKS_IN_YEAR = isoWeeksInYear(CURRENT.year);
const NEXT_START = isoWeekStart(CURRENT.year, CURRENT.week);
NEXT_START.setUTCDate(NEXT_START.getUTCDate() + 7);
const NEXT = isoWeek(NEXT_START);
/** A week of THIS ISO year the seed deliberately leaves without availability. */
const UNENCODED_WEEK = [1, 2, 3].find((w) => w !== CURRENT.week && w !== NEXT.week)!;
/**
 * The dashboard's ISO WEEK selector deliberately covers ONE ISO year (the
 * dashboard's current one). In the single week where the next ISO week belongs
 * to another year — late December — a "generate the next week" assertion would
 * mis-target that week number, so it is skipped there.
 */
const NEXT_IS_SAME_YEAR = NEXT.year === CURRENT.year;

test.describe("Generate Suguan modal", () => {
  test("exposes the ISO WEEK selector and all four generation methods", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Generate Suguan" }).click();
    const dialog = page.getByRole("dialog", { name: "Generate Suguan" });
    await expect(dialog).toBeVisible();

    // ISO WEEK — the year's weeks, current week preselected, no silent year change.
    const weekSelect = dialog.getByLabel("ISO WEEK");
    await expect(weekSelect).toHaveValue(String(CURRENT.week));
    const values = await weekSelect.locator("option").evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value),
    );
    expect(values).toHaveLength(WEEKS_IN_YEAR);
    expect(values[0]).toBe("1");
    expect(values[values.length - 1]).toBe(String(WEEKS_IN_YEAR)); // 52, or 53 when it exists
    await weekSelect.selectOption(String(UNENCODED_WEEK));
    await expect(weekSelect).toHaveValue(String(UNENCODED_WEEK));
    await expect(dialog.getByText(`ISO WEEK: ${UNENCODED_WEEK} — ${CURRENT.year}`)).toBeVisible();

    // All four methods of Update #19 are still offered.
    const mode = dialog.getByLabel(/how would you like to generate/i);
    const modes = await mode.locator("option").evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value),
    );
    expect(modes).toEqual(["auto", "manual", "destinado", "katuwang"]);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("blocks generation when the selected week's availability is not set", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Generate Suguan" }).click();
    const dialog = page.getByRole("dialog", { name: "Generate Suguan" });
    await dialog.getByLabel("ISO WEEK").selectOption(String(UNENCODED_WEEK));
    await dialog.getByRole("button", { name: "Confirm" }).click();

    // The blocking notice appears INSIDE the still-open modal, naming the
    // SELECTED week, with the Weekly Availability action.
    const notice = dialog.getByRole("alert");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Weekly Availability Required");
    await expect(notice).toContainText(/Weekly Availability has not been set/);
    await expect(notice).toContainText(`ISO Week ${UNENCODED_WEEK}, ${CURRENT.year}`);
    // Update #24 — the action lands in “fix availability” mode, which
    // highlights the missing teachers and offers the one-click fill.
    await expect(notice.getByRole("link", { name: "Go to Weekly Availability" })).toHaveAttribute(
      "href",
      `/availability?year=${CURRENT.year}&week=${UNENCODED_WEEK}&fix=1`,
    );
    await expect(dialog).toBeVisible();

    // Nothing was generated, and the selected week is never switched.
    await expect(dialog.getByLabel("ISO WEEK")).toHaveValue(String(UNENCODED_WEEK));
    await expect(page.locator(".generate-suguan").getByRole("status")).toHaveCount(0);

    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("generates the SELECTED week (not the browser's week) and the modal closes on success", async ({ page }) => {
    test.skip(!NEXT_IS_SAME_YEAR, "the next ISO week belongs to another ISO year this week");
    await page.goto("/");
    await page.getByRole("button", { name: "Generate Suguan" }).click();
    const dialog = page.getByRole("dialog", { name: "Generate Suguan" });
    await dialog.getByLabel("ISO WEEK").selectOption(String(NEXT.week));
    await dialog.getByLabel(/how would you like to generate/i).selectOption("auto");
    await dialog.getByRole("button", { name: "Confirm" }).click();

    await expect(dialog).toBeHidden();
    const message = page.locator(".generate-suguan").getByRole("status");
    await expect(message).toContainText(/Generated \d+ assignment\(s\)/);
    await expect(message).toContainText(`ISO W${String(NEXT.week).padStart(2, "0")} · ${NEXT.year}`);
    await expect(message).toContainText("the week remains DRAFT.");
    await expect(message).not.toContainText("undefined"); // response-envelope regression
  });

  test("Assign Katuwang runs through the gate and reports real numbers", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Generate Suguan" }).click();
    const dialog = page.getByRole("dialog", { name: "Generate Suguan" });
    await expect(dialog.getByLabel(/how would you like to generate/i)).toHaveValue("auto");

    await dialog.getByLabel(/how would you like to generate/i).selectOption("katuwang");
    await dialog.getByRole("button", { name: "Confirm" }).click();

    // Regression: success must CLOSE the modal — not hide the result behind it.
    await expect(dialog).toBeHidden();
    const message = page.locator(".generate-suguan").getByRole("status");
    await expect(message).toContainText(/Assign Katuwang: (re-)?assigned [1-9]\d* slot\(s\)/);
    await expect(message).toContainText(`ISO W${String(CURRENT.week).padStart(2, "0")} · ${CURRENT.year}`);
    await expect(message).not.toContainText("undefined");
  });

  test("Manual is gated and opens the SELECTED week's schedule", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Generate Suguan" }).click();
    const dialog = page.getByRole("dialog", { name: "Generate Suguan" });
    await dialog.getByLabel("ISO WEEK").selectOption(String(CURRENT.week));
    await dialog.getByLabel(/how would you like to generate/i).selectOption("manual");
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await page.waitForURL(new RegExp(`/schedule\\?year=${CURRENT.year}&week=${CURRENT.week}`));
  });

  test("dashboard teacher name: 8pt, middle name hidden, suffix kept, badges intact", async ({ page }) => {
    // The matrix only renders teacher names once the week has assignments, so
    // this test generates first and stays independent of its siblings.
    await page.goto("/");
    await page.getByRole("button", { name: "Generate Suguan" }).click();
    const dialog = page.getByRole("dialog", { name: "Generate Suguan" });
    await dialog.getByLabel(/how would you like to generate/i).selectOption("katuwang");
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect(dialog).toBeHidden();

    await page.reload();
    const nameCell = page.locator(".cell-name", { hasText: "Alfa" }).first();
    await expect(nameCell).toBeVisible();

    // Update #12 (middle hidden) + Update #3 (suffix kept) + Update #22 (8pt).
    await expect(nameCell).toHaveText(/^Destinado Alfa, Jr\.$/);
    for (const rendered of await page.locator(".cell-name").all()) {
      expect(await rendered.innerText()).not.toContain("Middle");
    }
    const px = await nameCell.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(px).toBeGreaterThan(10.4); // 8pt ≈ 10.67px — the old 10pt was ≈13.33px
    expect(px).toBeLessThan(10.9);

    // Update #20 — the micro-badge machinery is untouched (styles present; any
    // rendered badge keeps its accessible label).
    const badgeStylesPresent = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules ?? [])) {
            if (rule.cssText?.includes(".cell-badge")) return true;
          }
        } catch {
          /* cross-origin sheets are not readable — irrelevant here */
        }
      }
      return false;
    });
    expect(badgeStylesPresent).toBe(true);
    for (const badge of await page.locator(".cell-badge").all()) {
      expect(await badge.getAttribute("aria-label")).toBeTruthy();
    }

    // Layout integrity: rows stay single-height and the matrix keeps its own
    // horizontal scroll container (no overflow regression).
    const rowHeight = await page
      .locator(".annual-table tbody tr")
      .first()
      .evaluate((el) => (el as HTMLElement).offsetHeight);
    expect(rowHeight).toBeGreaterThan(0);
    expect(rowHeight).toBeLessThan(120);
    const scrollOk = await page
      .locator(".annual-scroll")
      .first()
      .evaluate((el) => el.scrollWidth >= el.clientWidth);
    expect(scrollOk).toBe(true);
  });

  test("Update #1 — the Dako name is a row header at 8pt; the column header is not", async ({ page }) => {
    await page.goto("/");
    const rowHead = page.locator(".annual-table tbody th.dako-row-head").first();
    await expect(rowHead).toBeVisible();
    // It is still the row's HEADER cell and still carries the real name.
    expect(await rowHead.evaluate((el) => el.getAttribute("scope"))).toBe("row");
    await expect(rowHead).toContainText("E2E Dako");

    const rowPx = await rowHead.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(rowPx).toBeGreaterThan(10.4); // 8pt ≈ 10.67px (the old 12.5px body scale)
    expect(rowPx).toBeLessThan(10.9);

    // The scope is the ROW: the "Dako" column header keeps the header scale, so
    // the change cannot have leaked into the sticky column machinery.
    const colHead = page.locator(".annual-table thead th.dako-col").first();
    const colPx = await colHead.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(colPx).toBeGreaterThan(10.4);
    expect(colPx).toBeLessThan(11.6);
    expect(colPx).toBeGreaterThan(rowPx);
  });

  test("Update #10 — the seven Dashboard micro-badge hues are distinct, in both themes", async ({ page }) => {
    const TOKENS = [
      "--mb-published",
      "--mb-finalized",
      "--mb-override",
      "--mb-manual",
      "--mb-historical",
      "--mb-updated",
      "--mb-absent",
    ];
    const CLASSES = ["published", "finalized", "override", "manual", "historical", "updated", "absent"];

    await page.goto("/");
    // Reads the theme actually in force AND, for every `.cb-*` class, the hue it
    // paints with — so a class wired to the wrong token (or to a hardcoded
    // colour) fails here even when the tokens themselves are distinct.
    const read = () =>
      page.evaluate(
        ({ tokens, classes }) => {
          const root = getComputedStyle(document.documentElement);
          const resolved = tokens.map((t) => root.getPropertyValue(t).trim().toLowerCase());
          const rings = classes.map((c) => {
            const probe = document.createElement("span");
            probe.className = `cell-badge cb-${c}`;
            document.body.appendChild(probe);
            const value = getComputedStyle(probe).getPropertyValue("--mb-ring").trim().toLowerCase();
            probe.remove();
            return value;
          });
          return { resolved, rings, theme: document.documentElement.dataset.theme ?? "light" };
        },
        { tokens: TOKENS, classes: CLASSES },
      );

    const assertDistinct = (values: string[]) => {
      expect(values).toHaveLength(TOKENS.length);
      for (const value of values) expect(value, "every badge must resolve to a real colour").toMatch(/^#[0-9a-f]{6}$/);
      expect(new Set(values).size).toBe(values.length);
    };

    const light = await read();
    assertDistinct(light.resolved);
    expect(light.rings).toEqual(light.resolved);
    // The two collisions of the old scheme must stay fixed.
    expect(light.resolved[2]).not.toBe(light.resolved[6]); // OVERRIDE ≠ ABSENT
    expect(light.resolved[1]).not.toBe(light.resolved[5]); // FINALIZED ≠ UPDATED

    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const dark = await read();
    assertDistinct(dark.resolved);
    expect(dark.rings).toEqual(dark.resolved);
    expect(dark.resolved[2]).not.toBe(dark.resolved[6]);
    expect(dark.resolved[1]).not.toBe(dark.resolved[5]);
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  });
});
