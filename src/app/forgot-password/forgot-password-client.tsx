"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { checkPasswordStrength } from "@/lib/password-strength";

type Step = "email" | "verify" | "reset" | "done";

interface ApiResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}

async function postJson(url: string, body: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      data?: { message?: string; ticket?: string };
      error?: { message?: string; issues?: { message: string }[] };
    };
    if (!res.ok) {
      const detail = payload.error?.issues?.map((i) => i.message).join("; ");
      return { ok: false, message: payload.error?.message ?? detail ?? "Request failed." };
    }
    return { ok: true, message: payload.data?.message, data: payload.data };
  } catch {
    return { ok: false, message: "Network error — please try again." };
  }
}

/**
 * Self-service recovery UI (Group 1). Presentation and flow only: every
 * security decision (rate limits, expiry, attempt caps, ticket scope, password
 * policy) is enforced server-side by the password-reset service. The code and
 * ticket are held in component state for the duration of the flow — never in
 * localStorage, sessionStorage, a cookie, or the URL.
 */
export function ForgotPasswordClient() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [ticket, setTicket] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((c) => (c > 0 ? c - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const strength = checkPasswordStrength(password);

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const result = await postJson("/api/auth/forgot-password", { email });
    setBusy(false);
    // The response is intentionally identical for every outcome.
    setNotice(result.message ?? "If an account exists for this email, a verification code has been sent.");
    setStep("verify");
    setCode("");
    setCooldown(60);
  }

  async function resend() {
    setError(null);
    setBusy(true);
    const result = await postJson("/api/auth/forgot-password", { email });
    setBusy(false);
    setNotice(result.message ?? "If an account exists for this email, a verification code has been sent.");
    setCode("");
    setCooldown(60);
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const result = await postJson("/api/auth/verify-reset-code", { email, code });
    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? "Invalid or expired code.");
      setCode("");
      return;
    }
    const data = result.data as { ticket?: string } | undefined;
    if (!data?.ticket) {
      setError("Invalid or expired code.");
      return;
    }
    setTicket(data.ticket);
    setNotice(null);
    setStep("reset");
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!ticket) {
      setError("Your verification expired. Please start again.");
      setStep("email");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    if (!strength.ok) {
      setError(`Password too weak: ${strength.checks.filter((c) => !c.ok).map((c) => c.rule).join("; ")}`);
      return;
    }
    setBusy(true);
    const result = await postJson("/api/auth/reset-password", { ticket, newPassword: password });
    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? "Reset failed. Please start again.");
      return;
    }
    // Nothing sensitive is kept after a successful reset.
    setTicket(null);
    setPassword("");
    setConfirm("");
    setCode("");
    setStep("done");
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            PNK
          </span>
          <div>
            <h1>Account recovery</h1>
            <p className="auth-sub">
              {step === "email" ? "Request a verification code" : null}
              {step === "verify" ? "Enter your verification code" : null}
              {step === "reset" ? "Choose a new password" : null}
              {step === "done" ? "Password updated" : null}
            </p>
          </div>
        </div>

        {error ? (
          <p className="error-note" role="alert">
            {error}
          </p>
        ) : null}
        {notice && step !== "done" ? <p className="info-note">{notice}</p> : null}

        {step === "email" ? (
          <form onSubmit={submitEmail} className="form-col">
            <label className="field">
              <span>
                Email <em>*</em>
              </span>
              <input
                name="email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
              />
            </label>
            <button type="submit" className="btn btn-primary auth-submit" disabled={busy} aria-busy={busy}>
              {busy ? "Sending…" : "Send verification code"}
            </button>
          </form>
        ) : null}

        {step === "verify" ? (
          <form onSubmit={submitCode} className="form-col">
            <label className="field">
              <span>
                Verification code <em>*</em>
              </span>
              <input
                name="code"
                className="otp-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                disabled={busy}
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary auth-submit"
              disabled={busy || code.length !== 6}
              aria-busy={busy}
            >
              {busy ? "Verifying…" : "Verify code"}
            </button>
            <div className="auth-links">
              <button
                type="button"
                className="link-btn"
                onClick={resend}
                disabled={busy || cooldown > 0}
              >
                {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
              </button>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setStep("email");
                  setError(null);
                  setNotice(null);
                  setCode("");
                }}
                disabled={busy}
              >
                Use a different email
              </button>
            </div>
          </form>
        ) : null}

        {step === "reset" ? (
          <form onSubmit={submitPassword} className="form-col">
            <label className="field">
              <span>
                New password <em>*</em>
              </span>
              <input
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="field">
              <span>
                Confirm new password <em>*</em>
              </span>
              <input
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
              />
            </label>
            <ul className="rule-list">
              {strength.checks.map((c) => (
                <li key={c.rule} data-ok={c.ok ? "true" : "false"}>
                  {c.ok ? "✓" : "○"} {c.rule}
                </li>
              ))}
            </ul>
            <button type="submit" className="btn btn-primary auth-submit" disabled={busy} aria-busy={busy}>
              {busy ? "Saving…" : "Set new password"}
            </button>
            <p className="info-note">
              All sessions signed in with the old password are signed out immediately.
            </p>
          </form>
        ) : null}

        {step === "done" ? (
          <div className="form-col">
            <p className="success-note" role="status">
              Your password has been updated. Sign in with your new password.
            </p>
            <Link className="btn btn-primary auth-submit" href="/login">
              Go to sign in
            </Link>
          </div>
        ) : null}

        {step !== "done" ? (
          <div className="auth-links auth-links-foot">
            <Link className="link-btn" href="/login">
              Back to sign in
            </Link>
          </div>
        ) : null}
      </div>
    </main>
  );
}
