export interface PasswordCheck {
  ok: boolean;
  rule: string;
}

/** Minimum policy: 10+ chars, upper, lower, digit, symbol. */
export function checkPasswordStrength(password: string): { ok: boolean; checks: PasswordCheck[] } {
  const checks: PasswordCheck[] = [
    { rule: "at least 10 characters", ok: password.length >= 10 },
    { rule: "contains uppercase letter", ok: /[A-Z]/.test(password) },
    { rule: "contains lowercase letter", ok: /[a-z]/.test(password) },
    { rule: "contains digit", ok: /\d/.test(password) },
    { rule: "contains symbol", ok: /[^A-Za-z0-9]/.test(password) },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}
