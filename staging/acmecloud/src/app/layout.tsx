import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = { title: "AcmeCloud" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <span className="logo">AcmeCloud</span>
          <nav aria-label="Main">
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/settings/billing">Billing</Link>
          </nav>
        </header>
        <main className="content">{children}</main>
      </body>
    </html>
  );
}
