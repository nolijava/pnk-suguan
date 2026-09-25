/**
 * Login form smoke — validation, uniform failure, happy path.
 * Runs in a fresh (unauthenticated) context on purpose.
 */
import { test, expect } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./paths";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("login form", () => {
  test("empty submit is blocked by required-field validation", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    // Native constraint validation blocks the submit: still on /login, no
    // server round-trip, and the empty required fields are marked invalid.
    await expect(page).toHaveURL(/\/login/);
    await expect(page).toHaveURL(/^(?!.*error=)/); // nothing was sent to the server
    await expect(page.locator('[name="email"]:invalid')).toHaveCount(1);
    await expect(page.locator('[name="password"]:invalid')).toHaveCount(1);
  });

  test("wrong credentials show the uniform error", async ({ page }) => {
    await page.goto("/login");
    // Throwaway account — failed logins throttle per account+IP, and this one
    // is never used again (the seeded admin can never be locked out by tests).
    await page.locator('[name="email"]').fill(`smoke-nouser-${Date.now()}@test.local`);
    await page.locator('[name="password"]').fill("WrongPass123!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/login\?error=/);
    // NB: not getByRole("alert") — the Next dev overlay keeps an empty alert
    // region live, which would make the locator ambiguous.
    await expect(page.locator(".error-note")).toContainText("Invalid credentials");
  });

  test("valid credentials sign in to the dashboard", async ({ page }) => {
    await page.goto("/login");
    await page.locator('[name="email"]').fill(E2E_EMAIL);
    await page.locator('[name="password"]').fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.getByRole("button", { name: "Generate Suguan" })).toBeVisible();
  });
});
