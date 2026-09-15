import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PNK Suguan System",
  description: "Teacher Assignment & Suguan Management System (development admin)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#f6f7f9" }}>
        {children}
      </body>
    </html>
  );
}
