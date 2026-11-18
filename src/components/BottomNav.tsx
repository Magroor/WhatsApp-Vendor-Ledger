"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", icon: "🏠", label: "Home" },
  { href: "/vendors", icon: "👥", label: "Vendors" },
  { href: "/inbox", icon: "💬", label: "Inbox" },
  { href: "/import", icon: "📥", label: "Import" },
  { href: "/reports", icon: "📊", label: "Reports" },
];

export default function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="tabbar no-print">
      <div className="tabbar-inner px-2">
        {TABS.map((tab) => {
          const active =
            tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className="tab-item"
              data-active={active}
              aria-current={active ? "page" : undefined}
            >
              <span className="tab-icon">{tab.icon}</span>
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
