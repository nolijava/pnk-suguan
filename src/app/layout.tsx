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

export const metadata: Metadata = {
  title: "PNK Suguan System",
  description: "Teacher Assignment & Suguan Management System (development admin)",
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
