/**
 * New Update #4/#5 — report PDF downloads, end to end.
 *
 * The service-level rendering is covered by the integration suite; what only a
 * browser can prove is the WIRING: that every report page actually offers the
 * Generate PDF affordance, that the link carries the filters the operator is
 * looking at, that the route answers with a real PDF attachment under the
 * operator's own session, and that the masterlist field-selection modal builds
 * the `fields` parameter from exactly what was ticked.
 *
 * Requests go through `page.request`, which shares the page's session cookie —
 * so this exercises authentication, RBAC and the response headers for real.
 */
import { test, expect, type Page } from "@playwright/test";
import { isoWeek } from "../src/lib/iso-week";
import { MASTERLIST_DEFAULT_FIELDS, MASTERLIST_FIELD_CODES } from "../src/lib/masterlist";

const CURRENT = isoWeek(new Date());

/**
 * Every report page of the system, with the PDF id it must link to and the
 * query parameters the link must carry. The teacher/dako history reports treat
 * their filters as OPTIONAL (no filter = the whole history), so they are only
 * required to carry a year once the page itself was opened with one.
 */
const REPORT_PAGES: { path: string; report: string; params: string[] }[] = [
  { path: "/reports", report: "source-summary", params: ["year"] },
  { path: "/reports/annual", report: "annual", params: ["year", "type"] },
  { path: "/reports/weekly", report: "weekly", params: ["year", "week"] },
  { path: "/reports/teacher", report: "teacher", params: [] },
  { path: "/reports/dako", report: "dako", params: [] },
  { path: "/reports/celebrations", report: "celebrations", params: ["year", "month"] },
];

/** Shape of each filter parameter the PDF link is allowed to carry. */
const PARAM_SHAPES: Record<string, (value: string) => boolean> = {
  year: (v) => /^\d{4}$/.test(v),
  week: (v) => Number(v) >= 1 && Number(v) <= 53,
  month: (v) => Number(v) >= 1 && Number(v) <= 12,
  type: (v) => ["SUGO", "RESERBA", "RESERBA_II"].includes(v),
};

function queryOf(href: string): URLSearchParams {
  return new URL(href, "http://localhost").searchParams;
}

async function pdfLink(page: Page, report: string) {
  const link = page.locator(`a[href^="/api/reports/${report}/pdf"]`).first();
  await expect(link).toBeVisible();
  return link;
}

/** Fetch a PDF URL with the page's session and assert it IS one. */
async function expectRealPdf(page: Page, href: string): Promise<Buffer> {
  const response = await page.request.get(href);
  expect(response.status(), `${href} must be served under the operator's session`).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/pdf");
  expect(response.headers()["content-disposition"]).toContain("attachment");
  expect(response.headers()["cache-control"]).toContain("no-store");
  const body = await response.body();
  expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(body.length).toBeGreaterThan(1000);
  return body;
}

test.describe("report PDFs", () => {
  test("every report page links to its own PDF, and each one downloads a real file", async ({ page }) => {
    for (const { path, report, params } of REPORT_PAGES) {
      await page.goto(path);
      const link = await pdfLink(page, report);
      await expect(link).toHaveAttribute("rel", "nofollow");

      const href = (await link.getAttribute("href"))!;
      const url = new URL(href, "http://localhost");
      expect(url.pathname).toBe(`/api/reports/${report}/pdf`);

      // The file reports on what the page is showing: the page's own filters.
      const query = queryOf(href);
      for (const name of params) {
        const value = query.get(name);
        expect(value, `${path} must carry \u201c${name}\u201d`).toBeTruthy();
        expect(PARAM_SHAPES[name]!(value!), `${path} \u2014 ${name}=${value} is not a valid filter`).toBe(true);
      }
      await expectRealPdf(page, href);
    }
  });

  test("the PDF link carries the filters currently applied on the page", async ({ page }) => {
    const week = CURRENT.week;
    const year = CURRENT.year;

    await page.goto(`/reports/weekly?year=${year}&week=${week}`);
    const weekly = await pdfLink(page, "weekly");
    const weeklyHref = (await weekly.getAttribute("href"))!;
    expect(weeklyHref).toContain(`year=${year}`);
    expect(weeklyHref).toContain(`week=${week}`);
    await expectRealPdf(page, weeklyHref);

    await page.goto(`/reports/annual?year=${year}&type=RESERBA`);
    const annual = await pdfLink(page, "annual");
    const annualHref = (await annual.getAttribute("href"))!;
    const annualQuery = queryOf(annualHref);
    expect(annualQuery.get("year")).toBe(String(year));
    expect(annualQuery.get("type")).toBe("RESERBA");
    await expectRealPdf(page, annualHref);

    // The history reports carry the year too, as soon as the page has one.
    for (const report of ["teacher", "dako"]) {
      await page.goto(`/reports/${report}?year=${year}`);
      const link = await pdfLink(page, report);
      expect(queryOf((await link.getAttribute("href"))!).get("year")).toBe(String(year));
    }
  });

  test("the download is a real browser download of a PDF attachment", async ({ page }) => {
    await page.goto("/reports/weekly");
    const link = await pdfLink(page, "weekly");
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const path = await download.path();
    expect(path).toBeTruthy();
    const { readFile } = await import("node:fs/promises");
    const body = await readFile(path!);
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Nothing was generated BY the download itself.
    expect(await download.failure()).toBeNull();
  });
});

test.describe("teacher masterlist PDF (#4)", () => {
  const masterlistPath = "/reports/teacher-masterlist";

  test("the field-selection modal builds the export from exactly what is ticked", async ({ page }) => {
    await page.goto(masterlistPath);
    await page.getByRole("button", { name: "Generate PDF — choose fields…" }).click();
    const dialog = page.getByRole("dialog", { name: "Teacher Masterlist PDF" });
    await expect(dialog).toBeVisible();

    // Core fields (the default) — the href lists them in catalogue order.
    await dialog.getByRole("button", { name: "Core fields" }).click();
    const coreExpected = MASTERLIST_FIELD_CODES.filter((c) => MASTERLIST_DEFAULT_FIELDS.includes(c));
    const coreLink = dialog.getByRole("link", { name: "Generate PDF" });
    const coreHref = (await coreLink.getAttribute("href"))!;
    expect(queryOf(coreHref).get("fields")).toBe(coreExpected.join(","));

    // Select all — every catalogue field, still in order.
    await dialog.getByRole("button", { name: "Select all" }).click();
    const allHref = (await coreLink.getAttribute("href"))!;
    expect(queryOf(allHref).get("fields")).toBe(MASTERLIST_FIELD_CODES.join(","));
    await expectRealPdf(page, allHref);

    // Clear — nothing ticked means no export is possible (fail-closed).
    await dialog.getByRole("button", { name: "Clear" }).click();
    await expect(dialog.getByText("Select at least one field to generate the PDF.")).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Generate PDF" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Generate PDF" })).toBeDisabled();

    // Cancel closes without navigating.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`${masterlistPath}$`));
  });

  test("an export of the page's filters produces a real PDF", async ({ page }) => {
    await page.goto(`${masterlistPath}?status=ACTIVE&duty=DESTINADO`);
    // The one-click default export carries the filters too.
    const oneClick = page.getByRole("link", { name: "Generate PDF (core fields)" });
    const oneClickHref = (await oneClick.getAttribute("href"))!;
    expect(queryOf(oneClickHref).get("status")).toBe("ACTIVE");
    expect(queryOf(oneClickHref).get("duty")).toBe("DESTINADO");
    await expectRealPdf(page, oneClickHref);

    await page.getByRole("button", { name: "Generate PDF — choose fields…" }).click();
    const dialog = page.getByRole("dialog", { name: "Teacher Masterlist PDF" });
    const link = dialog.getByRole("link", { name: "Generate PDF" });
    const href = (await link.getAttribute("href"))!;
    expect(queryOf(href).get("status")).toBe("ACTIVE");
    expect(queryOf(href).get("duty")).toBe("DESTINADO");
    await expectRealPdf(page, href);
  });
});

test.describe("Settings — email delivery + guide (#2/#3)", () => {
  test("reports email as NOT CONFIGURED and fails closed, without leaking a secret", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByText("NOT CONFIGURED", { exact: true })).toBeVisible();
    // The card names the KEYS, never a value.
    await expect(page.getByText("PNK_SMTP_HOST", { exact: false }).first()).toBeVisible();
    // With no SMTP the test button cannot be pressed at all.
    await expect(page.getByRole("button", { name: "Send test email to my account" })).toBeDisabled();

    // The honest failure notice (reached when a test was attempted) is rendered
    // on the page itself and still says nothing about credentials.
    await page.goto("/settings?emailTest=failed&reason=SMTP%20is%20not%20configured");
    await expect(page.getByText(/Test email was NOT sent/)).toBeVisible();
    await expect(page.getByText(/Configure the SMTP keys in this machine/)).toBeVisible();
    // The card still reports the state truthfully after the failed attempt.
    await expect(page.getByText("NOT CONFIGURED", { exact: true })).toBeVisible();
  });

  test("the Super Admin guide PDF is served from the app itself", async ({ page }) => {
    await page.goto("/settings");
    const link = page.getByRole("link", { name: "Open Super Admin Guide (PDF)" });
    await expect(link).toHaveAttribute("href", "/guides/SUPER-ADMIN-GUIDE.pdf");

    const response = await page.request.get("/guides/SUPER-ADMIN-GUIDE.pdf");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/pdf");
    const body = await response.body();
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(1000);
  });
});
