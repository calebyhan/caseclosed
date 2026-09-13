import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "CaseClosed",
  description: "Customer-reported bugs, reproduced and independently verified.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            CaseClosed
          </Link>
          <span className="tagline">The LLM interprets intent. Code establishes truth.</span>
        </header>
        <main className="page">{children}</main>
      </body>
    </html>
  );
}
