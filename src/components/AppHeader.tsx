"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TITLES: Record<string, { title: string; subtitle: string }> = {
  "/": { title: "KhataLink", subtitle: "WhatsApp vendor ledger" },
  "/vendors": { title: "Vendors", subtitle: "Separate khata per vendor" },
  "/inbox": { title: "WhatsApp Inbox", subtitle: "Bills, receipts & voice notes" },
  "/import": { title: "Import chat", subtitle: "From WhatsApp Export Chat" },
  "/guide": { title: "Guide", subtitle: "Set up & use, step by step" },
  "/reports": { title: "Reports", subtitle: "Weekly · monthly · yearly" },
  "/settings": { title: "Settings", subtitle: "Integration & automation" },
};

export default function AppHeader() {
  const pathname = usePathname();
  const meta = TITLES[pathname] ?? {
    title: "Vendor Ledger",
    subtitle: pathname.startsWith("/vendors/") ? "Vendor khata" : "Detail",
  };
  const isSettings = pathname === "/settings";

  return (
    <header className="header no-print">
      <div className="mx-auto flex max-w-[520px] items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="h1 truncate">{meta.title}</p>
          <p className="tiny muted truncate">{meta.subtitle}</p>
        </div>
        {isSettings ? (
          <Link href="/" className="btn btn-sm" aria-label="Back to dashboard">
            Done
          </Link>
        ) : (
          <Link href="/settings" className="btn btn-sm" aria-label="Settings">
            ⚙︎
          </Link>
        )}
      </div>
    </header>
  );
}
