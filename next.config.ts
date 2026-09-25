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
  // E2E isolation: the Playwright suite runs its own `next dev` beside the
  // developer's server — two servers sharing one .next corrupt each other
  // (a `next build` clobbering a running dev server is the same failure mode).
  // PNK_DIST_DIR is set only by playwright.config.ts (.next-e2e); every normal
  // run is untouched and keeps .next.
  distDir: process.env.PNK_DIST_DIR ?? ".next",
  // Dev-only: when the page is opened through a bare loopback host (embedded
  // preview frames request dev resources "from 127.0.0.1"), Next's dev-origin
  // protection 403s /_next/hmr and the devtools fonts. The refused HMR socket
  // keeps the dev client from bootstrapping React at all — every client control
  // (mobile nav drawer, modals, toggles) went dead while plain <a> links still
  // worked. Loopback hosts only; ignored in production builds.
  allowedDevOrigins: ["127.0.0.1", "localhost", "[::1]"],
  // L3 — local Windows packaging. `standalone` emits a self-contained server
  // tree (.next/standalone) with only the traced runtime dependencies, so the
  // package can ship its own Node runtime instead of requiring one on PATH.
  output: "standalone",
  outputFileTracingRoot: __dirname,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // Keep native/CJS-heavy modules outside the bundler; they are loaded at runtime.
  // nodemailer is server-only (password-reset delivery) and uses dynamic requires.
  // pdfkit is listed because it reads its Helvetica metrics from its own
  // `js/data/*.afm` files at runtime via fs — bundling it would drop those data
  // files and break PDF generation in the packaged build.
  serverExternalPackages: ["@node-rs/argon2", "postgres", "nodemailer", "pdfkit"],
  typescript: {
    // Typechecking is run explicitly via `npm run typecheck`.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
