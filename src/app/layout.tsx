import type { Metadata } from "next";
import { Manrope, Inter } from "next/font/google";
import "./globals.css";

const display = Manrope({ subsets: ["latin"], display: "swap", variable: "--font-display" });
const ui = Inter({ subsets: ["latin"], display: "swap", variable: "--font-ui" });

export const metadata: Metadata = {
  title: "PNK Suguan System",
  description: "Teacher Assignment & Suguan Management System (development admin)",
};

/**
 * Applied before first paint so the stored theme never flashes: reads the
 * persisted choice, otherwise the OS preference, otherwise Sacred Minimal
 * (light). Purely presentational — no application state is touched.
 */
const THEME_BOOTSTRAP = `(function(){try{var s=localStorage.getItem('pnk-theme');var t=(s==='dark'||s==='light')?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='light';}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="light"
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
