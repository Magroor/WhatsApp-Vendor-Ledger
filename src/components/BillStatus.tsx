import { formatMinor } from "@/lib/money";
import type { BillStatus as BillStatusRow } from "@/lib/allocations-core";

/** Small settlement badge for a bill (credit) entry: "Settled" or "Open Rs 8,500 of Rs 13,500". */
export default function BillStatus({ status, currency }: { status: BillStatusRow | undefined; currency: string }) {
  if (!status) return null;
  if (status.status === "settled") {
    return (
      <span className="pill pill-credit" title="Fully paid">
        Settled
      </span>
    );
  }
  const label = `Open ${formatMinor(status.openMinor, currency)} of ${formatMinor(status.originalMinor, currency)}`;
  return (
    <span className="pill pill-warn" title={status.status === "partial" ? "Partly paid" : "Not paid yet"}>
      {label}
    </span>
  );
}
