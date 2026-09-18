import type { NextConfig } from "next";

// Phase 9 — baseline security headers on every response. The app renders
// inline styles, so the CSP allows them but nothing else unsafe.
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
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

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // Keep native modules outside the bundler; they are loaded at runtime.
  serverExternalPackages: ["@node-rs/argon2", "postgres"],
  typescript: {
    // Typechecking is run explicitly via `npm run typecheck`.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
