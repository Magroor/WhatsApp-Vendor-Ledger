import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import AppHeader from "@/components/AppHeader";
import BottomNav from "@/components/BottomNav";
import IosRuntime from "@/components/IosRuntime";

export const metadata: Metadata = {
  title: "KhataLink — WhatsApp Vendor Ledger",
  description:
    "Automated credit & debit bookkeeping for vendors. WhatsApp bills in, clean ledgers and weekly/monthly/yearly reports out.",
  applicationName: "KhataLink",
  appleWebApp: {
    capable: true,
    title: "KhataLink",
    statusBarStyle: "black-translucent",
  },
  manifest: "/manifest.webmanifest",
  formatDetection: { telephone: false },
  icons: {
    icon: [{ url: "/icon.png", sizes: "512x512", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#05070f",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <IosRuntime />
        <div className="app-shell">
          <AppHeader />
          <main className="px-4 pb-4 pt-3">{children}</main>
          <BottomNav />
        </div>
      </body>
    </html>
  );
}
