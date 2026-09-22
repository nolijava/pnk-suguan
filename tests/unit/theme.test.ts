/**
 * Group 3 — theme stability unit tests.
 *
 * The reported bug was a light→dark flip after ordinary button clicks: the
 * choice lived only in localStorage with a live OS-preference fallback, so any
 * full document load re-evaluated `prefers-color-scheme` when storage was empty.
 * These tests pin the resolution order and the "latch" behaviour that removes it.
 */
import { describe, it, expect } from "vitest";
import { isTheme, resolveTheme, THEME_BOOTSTRAP, THEME_COOKIE, THEME_STORAGE_KEY } from "@/lib/theme";

describe("resolveTheme", () => {
  it("prefers an explicit cookie over everything else", () => {
    expect(resolveTheme({ cookie: "dark", stored: "light", prefersDark: false })).toBe("dark");
    expect(resolveTheme({ cookie: "light", stored: "dark", prefersDark: true })).toBe("light");
  });

  it("falls back to the stored choice when no cookie is present", () => {
    expect(resolveTheme({ cookie: null, stored: "dark", prefersDark: false })).toBe("dark");
    expect(resolveTheme({ cookie: undefined, stored: "light", prefersDark: true })).toBe("light");
  });

  it("uses the OS preference only when nothing has been chosen yet", () => {
    expect(resolveTheme({ cookie: null, stored: null, prefersDark: true })).toBe("dark");
    expect(resolveTheme({ cookie: null, stored: null, prefersDark: false })).toBe("light");
  });

  it("defaults to light with no cookie, no storage, and no OS preference", () => {
    expect(resolveTheme({})).toBe("light");
    expect(resolveTheme({ cookie: null, stored: null, prefersDark: false })).toBe("light");
  });

  it("ignores invalid values instead of trusting them", () => {
    expect(resolveTheme({ cookie: "purple", stored: "", prefersDark: true })).toBe("dark");
    expect(resolveTheme({ cookie: "", stored: "DARK", prefersDark: false })).toBe("light");
    expect(resolveTheme({ cookie: "dark-mode", stored: null, prefersDark: false })).toBe("light");
  });

  it("isTheme accepts only the two real themes", () => {
    expect(isTheme("light")).toBe(true);
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("Dark")).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });
});

describe("THEME_BOOTSTRAP", () => {
  it("reads the cookie first, then storage, then the OS preference", () => {
    const cookieIdx = THEME_BOOTSTRAP.indexOf("document.cookie");
    const storageIdx = THEME_BOOTSTRAP.indexOf("localStorage.getItem");
    const osIdx = THEME_BOOTSTRAP.indexOf("prefers-color-scheme");
    expect(cookieIdx).toBeGreaterThan(-1);
    expect(storageIdx).toBeGreaterThan(cookieIdx);
    expect(osIdx).toBeGreaterThan(storageIdx);
  });

  it("LATCHES the resolved value into both the cookie and localStorage", () => {
    // Without this write the OS preference would be re-consulted on the next
    // full page load — exactly the reported flip.
    expect(THEME_BOOTSTRAP).toContain("document.cookie='pnk-theme='");
    expect(THEME_BOOTSTRAP).toContain("localStorage.setItem('pnk-theme'");
  });

  it("applies the theme to <html> and never throws unguarded", () => {
    expect(THEME_BOOTSTRAP).toContain("document.documentElement.dataset.theme=t");
    expect(THEME_BOOTSTRAP.startsWith("(function(){try{")).toBe(true);
    expect(THEME_BOOTSTRAP.trim().endsWith("})();")).toBe(true);
  });

  it("uses the shared cookie/storage key", () => {
    expect(THEME_COOKIE).toBe("pnk-theme");
    expect(THEME_STORAGE_KEY).toBe("pnk-theme");
    expect(THEME_BOOTSTRAP).toContain(THEME_STORAGE_KEY);
  });
});
