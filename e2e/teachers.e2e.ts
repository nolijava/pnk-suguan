/**
 * Add Teacher form smoke — required-field validation through the confirmation
 * modal, the ConfirmSubmit summary (regression: the summary must echo the
 * CHECKED Duty radio, not the first one), create + duty persistence, and the
 * "+ Add Another Guro" flow (regression: must return to a BLANK, USABLE form —
 * never a stuck-busy modal).
 */
import { test, expect } from "@playwright/test";

test.describe("Add Teacher form", () => {
  test("confirming an incomplete form is blocked and reports the invalid fields", async ({ page }) => {
    await page.goto("/teachers/new");
    await page.getByRole("button", { name: "Create Teacher" }).click();
    const dialog = page.getByRole("dialog", { name: "Create Teacher" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Create", exact: true }).click();

    // Validation runs before anything is armed: the modal closes, nothing is
    // submitted, and the required fields (incl. the Duty radio group) show.
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/teachers\/new/);
    await expect(page.locator('[name="firstName"]:invalid')).toHaveCount(1);
    await expect(page.locator('[name="lastName"]:invalid')).toHaveCount(1);
    await expect(page.locator('input[name="duty"]:invalid').first()).toBeVisible();
  });

  test("confirmation summary echoes the CHECKED Duty (regression)", async ({ page }) => {
    await page.goto("/teachers/new");
    await page.locator('[name="firstName"]').fill("Summary");
    await page.locator('[name="lastName"]').fill("Probe");
    await page.locator('input[name="duty"][value="KATUWANG"]').check();
    await page.getByRole("button", { name: "Create Teacher" }).click();

    const dialog = page.getByRole("dialog", { name: "Create Teacher" });
    const dutyRow = dialog.locator("tr", { hasText: "Duty" });
    await expect(dutyRow).toContainText("KATUWANG");
    // The bug this guards: reading the FIRST radio's value (DESTINADO).
    await expect(dutyRow).not.toContainText("DESTINADO");

    // Cancel mutates nothing — every entered value stays in place.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[name="firstName"]')).toHaveValue("Summary");
    await expect(page.locator('input[name="duty"][value="KATUWANG"]')).toBeChecked();
  });

  test("creating a teacher persists the Duty", async ({ page }) => {
    await page.goto("/teachers/new");
    await page.locator('[name="firstName"]').fill("Smoketest");
    await page.locator('[name="lastName"]').fill("Guroone");
    await page.locator('input[name="duty"][value="DESTINADO"]').check();
    await page.getByRole("button", { name: "Create Teacher" }).click();
    const dialog = page.getByRole("dialog", { name: "Create Teacher" });
    await dialog.getByRole("button", { name: "Create", exact: true }).click();

    await page.waitForURL(/\/teachers\/[0-9a-f-]{36}\?notice=/);
    const id = page.url().match(/teachers\/([0-9a-f-]{36})/)![1]!;

    // The list renders the new Guro.
    await page.goto("/teachers");
    await expect(page.locator("table").first()).toContainText("Guroone");

    // Duty persisted: the edit form reflects exactly what was chosen.
    await page.goto(`/teachers/${id}/edit`);
    await expect(page.locator('[name="firstName"]')).toHaveValue("Smoketest");
    await expect(page.locator('input[name="duty"][value="DESTINADO"]')).toBeChecked();
  });

  test("+ Add Another Guro returns to a blank, usable form (regression)", async ({ page }) => {
    await page.goto("/teachers/new");
    await page.locator('[name="firstName"]').fill("Second");
    await page.locator('[name="lastName"]').fill("Gurotwo");
    await page.locator('input[name="duty"][value="KATUWANG"]').check();
    await page.getByRole("button", { name: "+ Add Another Guro" }).click();

    const dialog = page.getByRole("dialog", { name: "Create Teacher and Add Another" });
    await dialog.getByRole("button", { name: "Create and continue" }).click();

    await page.waitForURL(/\/teachers\/new\?added=1/);
    await expect(page.getByText("Teacher created. Ready for the next Guro.")).toBeVisible();
    // Fresh blank form, and the modal's busy state resolved (never stuck).
    await expect(page.locator('[name="firstName"]')).toHaveValue("");
    await expect(page.getByRole("button", { name: "Create Teacher" })).toBeEnabled();
  });
});
