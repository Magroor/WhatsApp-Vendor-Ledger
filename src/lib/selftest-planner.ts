import { buildPayPlan } from "./planner";
import { computeOpenLots, type LedgerRow, type OpenLot } from "./reports";
import type { TestResult } from "./selftest";

const TZ = "Asia/Karachi";
// 2026-03-10 12:00 in Karachi.
const NOW = new Date("2026-03-10T07:00:00Z");

function lot(p: Partial<OpenLot> & { transactionId: number; remainingMinor: number; dueDate: string | null }): OpenLot {
  return {
    vendorId: 1,
    vendorName: "Vendor A",
    currency: "PKR",
    occurredAt: new Date("2026-02-01T07:00:00Z"),
    reference: null,
    originalMinor: p.remainingMinor,
    ageDays: 0,
    daysOverdue: 0,
    ...p,
  };
}

function row(p: Partial<LedgerRow> & { id: number; entryType: "credit" | "debit"; amountMinor: number; occurredAt: Date }): LedgerRow {
  return {
    vendorId: 1,
    vendorName: "Vendor A",
    vendorPhone: null,
    currency: "PKR",
    taxMinor: 0,
    dueDate: null,
    status: "confirmed",
    source: "manual",
    reference: null,
    description: null,
    confidence: 100,
    messageId: null,
    ...p,
  };
}

export function runPlannerSelfTests(): TestResult[] {
  const results: TestResult[] = [];
  const check = (name: string, pass: boolean, detail: string) =>
    results.push({ suite: "planner", name, pass, detail });

  const overdue = buildPayPlan([lot({ transactionId: 1, remainingMinor: 100000, dueDate: "2026-02-26" })], NOW, TZ);
  check(
    "overdue lot",
    overdue.vendors.length === 1 &&
      overdue.vendors[0].daysOverdue === 12 &&
      overdue.vendors[0].label === "overdue 12 days" &&
      overdue.overdueMinor === 100000,
    `label=${overdue.vendors[0]?.label}`,
  );

  const soon = buildPayPlan([lot({ transactionId: 2, remainingMinor: 50000, dueDate: "2026-03-13" })], NOW, TZ);
  check(
    "due in 3 days",
    soon.vendors[0]?.label === "due in 3 days" && soon.neededThisWeekMinor === 50000 && soon.overdueMinor === 0,
    `label=${soon.vendors[0]?.label} needed=${soon.neededThisWeekMinor}`,
  );

  const later = buildPayPlan([lot({ transactionId: 3, remainingMinor: 70000, dueDate: "2026-03-30" })], NOW, TZ);
  check(
    "due in 20 days excluded from this week",
    later.vendors.length === 0 && later.neededThisWeekMinor === 0 && later.laterMinor === 70000,
    `vendors=${later.vendors.length} later=${later.laterMinor}`,
  );

  const edge = buildPayPlan(
    [
      lot({ transactionId: 4, remainingMinor: 10000, dueDate: "2026-03-17" }),
      lot({ transactionId: 5, vendorId: 2, vendorName: "Vendor B", remainingMinor: 20000, dueDate: "2026-03-18" }),
    ],
    NOW,
    TZ,
  );
  check(
    "7-day window boundary",
    edge.vendors.length === 1 && edge.vendors[0].vendorId === 1 && edge.laterMinor === 20000,
    `vendors=${edge.vendors.map((v) => v.vendorId).join(",")}`,
  );

  // Partial FIFO: bill 1000 (due long ago) + bill 500 (due in 2 days), pay 1200 -> 300 left on the 2nd.
  const fifoRows: LedgerRow[] = [
    row({ id: 1, entryType: "credit", amountMinor: 100000, occurredAt: new Date("2026-02-01T07:00:00Z"), dueDate: "2026-02-15" }),
    row({ id: 2, entryType: "credit", amountMinor: 50000, occurredAt: new Date("2026-03-01T07:00:00Z"), dueDate: "2026-03-12" }),
    row({ id: 3, entryType: "debit", amountMinor: 120000, occurredAt: new Date("2026-03-05T07:00:00Z") }),
  ];
  const fifoPlan = buildPayPlan(computeOpenLots(fifoRows, NOW, { timeZone: TZ }), NOW, TZ);
  check(
    "partial FIFO settlement",
    fifoPlan.vendors.length === 1 &&
      fifoPlan.vendors[0].overdueMinor === 0 &&
      fifoPlan.vendors[0].dueSoonMinor === 30000 &&
      fifoPlan.vendors[0].label === "due in 2 days",
    `overdue=${fifoPlan.vendors[0]?.overdueMinor} soon=${fifoPlan.vendors[0]?.dueSoonMinor}`,
  );

  const settledRows: LedgerRow[] = [
    row({ id: 1, entryType: "credit", amountMinor: 100000, occurredAt: new Date("2026-02-01T07:00:00Z"), dueDate: "2026-02-15" }),
    row({ id: 2, entryType: "debit", amountMinor: 100000, occurredAt: new Date("2026-02-10T07:00:00Z") }),
  ];
  const settled = buildPayPlan(computeOpenLots(settledRows, NOW, { timeZone: TZ }), NOW, TZ);
  check("zero-balance vendor omitted", settled.vendors.length === 0 && settled.neededThisWeekMinor === 0, `vendors=${settled.vendors.length}`);

  const sorted = buildPayPlan(
    [
      lot({ transactionId: 10, vendorId: 1, vendorName: "Soon", remainingMinor: 10000, dueDate: "2026-03-12" }),
      lot({ transactionId: 11, vendorId: 2, vendorName: "Late5", remainingMinor: 10000, dueDate: "2026-03-05" }),
      lot({ transactionId: 12, vendorId: 3, vendorName: "Late20", remainingMinor: 10000, dueDate: "2026-02-18" }),
      lot({ transactionId: 13, vendorId: 4, vendorName: "Today", remainingMinor: 10000, dueDate: "2026-03-10" }),
    ],
    NOW,
    TZ,
  );
  const order = sorted.vendors.map((v) => v.vendorName).join(",");
  check("sort: overdue first, then by due date", order === "Late20,Late5,Today,Soon", `order=${order}`);

  return results;
}
