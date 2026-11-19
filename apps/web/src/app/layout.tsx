import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Socialith",
    template: "%s — Socialith",
  },
  description:
    "Socialith is a web-based social media management platform that lets creators and businesses securely connect and manage their social media accounts from one centralized workspace.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
