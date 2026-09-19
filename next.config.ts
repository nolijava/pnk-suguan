import type { NextConfig } from "next";

// Phase 9 — baseline security headers on every response. The app renders
// inline styles, so the CSP allows them but nothing else unsafe.
// Dev-only: React/Next.js development mode requires eval() for debugging
// features (dev overlay, callstack reconstruction), so 'unsafe-eval' is
// appended in non-production environments. Production never gets it.
const isDev = process.env.NODE_ENV !== "production";

/** Header set for a given environment; exported for direct branch testing. */
export function securityHeadersFor(dev: boolean): Array<{ key: string; value: string }> {
  return [
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    {
      key: "Content-Security-Policy",
      value: [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'" + (dev ? " 'unsafe-eval'" : ""),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),
    },
  ];
}

const SECURITY_HEADERS = securityHeadersFor(isDev);

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // Keep native/CJS-heavy modules outside the bundler; they are loaded at runtime.
  // nodemailer is server-only (password-reset delivery) and uses dynamic requires.
  serverExternalPackages: ["@node-rs/argon2", "postgres", "nodemailer"],
  typescript: {
    // Typechecking is run explicitly via `npm run typecheck`.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
