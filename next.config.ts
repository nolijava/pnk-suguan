import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native modules outside the bundler; they are loaded at runtime.
  serverExternalPackages: ["@node-rs/argon2", "postgres"],
  typescript: {
    // Typechecking is run explicitly via `npm run typecheck`.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
