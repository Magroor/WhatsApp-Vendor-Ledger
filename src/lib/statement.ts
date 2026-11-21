import { eq } from "drizzle-orm";
import { db } from "@/db";
import { vendors } from "@/db/schema";
import { formatMinor } from "./money";
import { loadLedgerRows } from "./reports";
import {
  civilOf,
  fmtDate,
  monthShort,
  normalizeCivil,
  resolveTimeZone,
  zonedToUtc,
} from "./time";

export type StatementRange = "month" | "3months" | "year" | "all";

export const STATEMENT_RANGES: Array<{ value: StatementRange; label: string }> = [
  { value: "month", label: "This month" },
  { value: "3months", label: "Last 3 months" },
  { value: "year", label: "This year" },
  { value: "all", label: "All time" },
];

export function parseStatementRange(raw: string | null | undefined): StatementRange {
  return raw === "3months" || raw === "year" || raw === "all" ? raw : "month";
}

export type StatementVendor = { name: string; phone: string | null };

export type StatementRow = {
  id: number;
  /** Pre-formatted date in the business timezone ("18 Feb 2026"). */
  dateLabel: string;
  reference: string | null;
  description: string | null;
  entryType: "credit" | "debit";
  amountMinor: number;
  /** Running balance after this entry (payable positive). */
  balanceMinor: number;
};

export type Statement = {
  vendor: StatementVendor & { id: number; currency: string };
  rows: StatementRow[];
  openingMinor: number;
  closingMinor: number;
  creditMinor: number;
  debitMinor: number;
  currency: string;
  rangeLabel: string;
  range: StatementRange;
  generatedLabel: string;
};

/** Plain-text statement suitable for WhatsApp. Pure. */
export function buildStatementText(
  vendor: StatementVendor,
  rows: StatementRow[],
  opening: number,
  closing: number,
  currency: string,
  rangeLabel: string,
): string {
  const fm = (n: number) => formatMinor(n, currency);
  const lines: string[] = [];
  lines.push(`*Statement for ${vendor.name}*`);
  lines.push(rangeLabel);
  lines.push("");
  lines.push(`Opening balance: ${fm(opening)}`);
  if (rows.length === 0) {
    lines.push("No entries in this period.");
  } else {
    for (const r of rows) {
      const what = [r.reference ? `#${r.reference}` : "", r.description ?? ""].filter(Boolean).join(" ");
      const kind = r.entryType === "credit" ? "Bill" : "Paid";
      lines.push(`${r.dateLabel} - ${kind} ${fm(r.amountMinor)}${what ? ` (${what.slice(0, 40)})` : ""}`);
    }
  }
  lines.push("");
  lines.push(`Closing balance: ${fm(closing)}`);
  lines.push(
    closing > 0
      ? `*Amount due now: ${fm(closing)}*`
      : closing < 0
        ? `Advance with you: ${fm(-closing)}`
        : "Nothing due. Account settled.",
  );
  return lines.join("\n");
}

function rangeStart(range: StatementRange, tz: string, now: Date): { start: Date | null; label: string } {
  const c = civilOf(now, tz);
  if (range === "all") return { start: null, label: "All time" };
  if (range === "year") return { start: zonedToUtc({ y: c.y, m: 1, d: 1 }, tz), label: `Year ${c.y}` };
  if (range === "3months") {
    const s = normalizeCivil(c.y, c.m - 2, 1);
    return {
      start: zonedToUtc(s, tz),
      label: `${monthShort(s.m)} ${s.y} to ${monthShort(c.m)} ${c.y}`,
    };
  }
  return { start: zonedToUtc({ y: c.y, m: c.m, d: 1 }, tz), label: `${monthShort(c.m)} ${c.y}` };
}

/** Loads a vendor statement for the period; null when the vendor does not exist. */
export async function loadStatement(
  vendorId: number,
  range: StatementRange,
  tz?: string,
): Promise<Statement | null> {
  const zone = resolveTimeZone(tz);
  const now = new Date();
  const [vendor] = await db.select().from(vendors).where(eq(vendors.id, vendorId)).limit(1);
  if (!vendor) return null;
  const all = await loadLedgerRows({ vendorId, statuses: ["confirmed"] });
  const { start, label } = rangeStart(range, zone, now);

  let opening = Number(vendor.openingBalanceMinor ?? 0);
  const inRange = [];
  for (const r of all) {
    if (start && r.occurredAt.getTime() < start.getTime()) {
      opening += r.entryType === "credit" ? r.amountMinor : -r.amountMinor;
    } else {
      inRange.push(r);
    }
  }

  let running = opening;
  let creditMinor = 0;
  let debitMinor = 0;
  const rows: StatementRow[] = inRange.map((r) => {
    if (r.entryType === "credit") {
      running += r.amountMinor;
      creditMinor += r.amountMinor;
    } else {
      running -= r.amountMinor;
      debitMinor += r.amountMinor;
    }
    return {
      id: r.id,
      dateLabel: fmtDate(r.occurredAt, zone),
      reference: r.reference,
      description: r.description,
      entryType: r.entryType,
      amountMinor: r.amountMinor,
      balanceMinor: running,
    };
  });

  return {
    vendor: { id: vendor.id, name: vendor.name, phone: vendor.phone, currency: vendor.currency },
    rows,
    openingMinor: opening,
    closingMinor: running,
    creditMinor,
    debitMinor,
    currency: vendor.currency,
    rangeLabel: label,
    range,
    generatedLabel: fmtDate(now, zone),
  };
}
