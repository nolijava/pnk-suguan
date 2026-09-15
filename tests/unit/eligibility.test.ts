import { describe, it, expect } from "vitest";
import { isTeacherEligibleForDako } from "@/lib/eligibility";
import { hasPermission, permissionsForRoles } from "@/server/auth/permissions";
import { checkPasswordStrength } from "@/lib/password-strength";

describe("language eligibility (§22)", () => {
  it("English teacher serves both languages", () => {
    expect(isTeacherEligibleForDako("ENGLISH", "ENGLISH")).toBe(true);
    expect(isTeacherEligibleForDako("ENGLISH", "FILIPINO")).toBe(true);
  });
  it("Filipino teacher serves Filipino only", () => {
    expect(isTeacherEligibleForDako("FILIPINO", "FILIPINO")).toBe(true);
    expect(isTeacherEligibleForDako("FILIPINO", "ENGLISH")).toBe(false);
  });
});

describe("RBAC permission map (§7)", () => {
  it("ADMIN has everything", () => {
    expect(hasPermission(["ADMIN"], "users.manage")).toBe(true);
    expect(hasPermission(["ADMIN"], "weeks.unlock")).toBe(true);
  });
  it("SCHEDULER cannot manage users or unlock", () => {
    expect(hasPermission(["SCHEDULER"], "users.manage")).toBe(false);
    expect(hasPermission(["SCHEDULER"], "weeks.unlock")).toBe(true ? false : false);
    expect(hasPermission(["SCHEDULER"], "teachers.write")).toBe(true);
  });
  it("VIEWER is read-only", () => {
    expect(hasPermission(["VIEWER"], "teachers.read")).toBe(true);
    expect(hasPermission(["VIEWER"], "teachers.write")).toBe(false);
    expect(hasPermission(["VIEWER"], "assignments.write")).toBe(false);
  });
  it("merges across multiple roles", () => {
    const perms = permissionsForRoles(["VIEWER", "SCHEDULER"]);
    expect(perms).toContain("assignments.write");
    expect(perms).not.toContain("users.manage");
  });
});

describe("password policy", () => {
  it("enforces minimum rules", () => {
    expect(checkPasswordStrength("short").ok).toBe(false);
    expect(checkPasswordStrength("Longenough1!").ok).toBe(true);
    expect(checkPasswordStrength("NoSymbolsHere1").ok).toBe(false);
  });
});
