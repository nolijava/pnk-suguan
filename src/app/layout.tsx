import type { Metadata } from "next";
import { cookies } from "next/headers";
import localFont from "next/font/local";
import { resolveTheme, THEME_BOOTSTRAP, THEME_COOKIE } from "@/lib/theme";
import "./globals.css";

/**
 * Fonts are vendored locally (variable woff2, latin subset) rather than fetched
 * from Google at build time, so a production build needs no network access at
 * all. Files live in src/app/fonts/ and are served from /_next/static/media.
 *
 * Weight RANGES are declared deliberately: the design system uses intermediate
 * weights (520/550/620/650/680) that only a variable font can render, so a
 * static weight list would silently change the typography.
 */
const display = localFont({
  src: "./fonts/manrope-latin-variable.woff2",
  weight: "200 800",
  style: "normal",
  display: "swap",
  variable: "--font-display",
});

const ui = localFont({
  src: "./fonts/inter-latin-variable.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-ui",
});

/**
 * The system logo is also the browser icon. Every icon points at the same
 * supplied artwork in public/logo/ (transparent SVG, its 64/256/512 PNG twins,
 * and the multi-resolution .ico the installer and shortcuts use) — no separate
 * favicon file to drift out of date. Browsers that understand SVG take the
 * vector (crisp at any size); the PNGs and the .ico cover the rest, and the 512
 * is offered as the iOS home-screen icon.
 */
export const metadata: Metadata = {
  title: "PNK Suguan System",
  description: "Teacher Assignment & Suguan Management System (development admin)",
  icons: {
    icon: [
      { url: "/logo/pnk-suguan-logo.svg", type: "image/svg+xml" },
      { url: "/logo/pnk-suguan.ico", type: "image/x-icon", sizes: "16x16 24x24 32x32 48x48 64x64 128x128 256x256" },
      { url: "/logo/pnk-suguan-logo-64.png", type: "image/png", sizes: "64x64" },
      { url: "/logo/pnk-suguan-logo-256.png", type: "image/png", sizes: "256x256" },
    ],
    shortcut: [{ url: "/logo/pnk-suguan.ico", type: "image/x-icon" }],
    apple: [{ url: "/logo/pnk-suguan-logo-512.png", type: "image/png", sizes: "512x512" }],
  },
};

/**
 * The persisted theme is resolved server-side from the cookie so the markup and
 * the client agree on first paint (no flash, no hydration mismatch). The inline
 * script then latches that value into the cookie/localStorage on a first visit,
 * after which the OS preference is never consulted again.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = resolveTheme({ cookie: (await cookies()).get(THEME_COOKIE)?.value ?? null });
  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${display.variable} ${ui.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
