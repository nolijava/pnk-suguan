/**
 * Setup project — ONE real login through the actual login form (itself a
 * smoke test of the auth flow), saved as storage state for the rest of the
 * suite. Login throttling is per account+IP, so the specs that probe failed
 * logins always use throwaway accounts and can never lock this one out.
 */
import { test as setup, expect } from "@playwright/test";
import { AUTH_STATE, E2E_EMAIL, E2E_PASSWORD } from "./paths";

setup("operator signs in through the login form", async ({ page }) => {
  await page.goto("/login");
  await page.locator('[name="email"]').fill(E2E_EMAIL);
  await page.locator('[name="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await expect(page.getByRole("button", { name: "Generate Suguan" })).toBeVisible();
  await page.context().storageState({ path: AUTH_STATE });
});
