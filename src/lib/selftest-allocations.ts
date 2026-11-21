import type { TestResult } from "./selftest";
import { availableForPayment, computeBillStatuses, type AllocTx } from "./allocations-core";
import { computeOpenLots, type LedgerRow } from "./reports";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n, 10, 0, 0));

function bill(id: number, amountMinor: number, d: number, status = "confirmed"): AllocTx {
  return { id, vendorId: 1, entryType: "credit", amountMinor, occurredAt: day(d), status, reference: `B${id}` };
}
function pay(id: number, amountMinor: number, d: number, status = "confirmed"): AllocTx {
  return { id, vendorId: 1, entryType: "debit", amountMinor, occurredAt: day(d), status };
}

export function runAllocationSelfTests(): TestResult[] {
  const out: TestResult[] = [];
  const suite = "allocations";
  const check = (name: string, pass: boolean, detail: string) => out.push({ suite, name, pass, detail });
  const find = (r: ReturnType<typeof computeBillStatuses>, id: number) => r.bills.find((b) => b.billId === id);
  const findP = (r: ReturnType<typeof computeBillStatuses>, id: number) => r.payments.find((p) => p.paymentId === id);

  // 1. pure FIFO: payment settles oldest bill first
  {
    const r = computeBillStatuses([bill(1, 1350000, 1), bill(2, 500000, 2)], [pay(10, 500000, 3)], []);
    const a = find(r, 1);
    const b = find(r, 2);
    check("FIFO settles oldest bill first", a?.openMinor === 850000 && a.autoMinor === 500000 && b?.openMinor === 500000, JSON.stringify(r.bills));
    check("partial status after FIFO", a?.status === "partial" && b?.status === "open", `${a?.status}/${b?.status}`);
  }

  // 2. explicit first, then FIFO for the remainder
  {
    const r = computeBillStatuses(
      [bill(1, 1350000, 1), bill(2, 500000, 2)],
      [pay(10, 800000, 3)],
      [{ paymentId: 10, billId: 2, amountMinor: 500000 }],
    );
    const a = find(r, 1);
    const b = find(r, 2);
    const p = findP(r, 10);
    check(
      "explicit applied before FIFO",
      b?.explicitMinor === 500000 && b.status === "settled" && a?.autoMinor === 300000 && a.openMinor === 1050000,
      JSON.stringify(r.bills),
    );
    check("payment allocated/unallocated split", p?.allocatedMinor === 500000 && p.unallocatedMinor === 300000 && p.autoMinor === 300000, JSON.stringify(p));
  }

  // 3. fully settled
  {
    const r = computeBillStatuses([bill(1, 100000, 1)], [pay(10, 100000, 2)], []);
    check("exact payment settles bill", find(r, 1)?.status === "settled" && find(r, 1)?.openMinor === 0, JSON.stringify(r.bills));
  }

  // 4. overpayment becomes an advance
  {
    const r = computeBillStatuses([bill(1, 100000, 1)], [pay(10, 250000, 2)], []);
    check("overpay -> advance", r.advanceMinor === 150000 && findP(r, 10)?.advanceMinor === 150000 && r.totalOpenMinor === 0, JSON.stringify(r));
  }

  // 5. void / draft rows excluded (and their allocations ignored)
  {
    const r = computeBillStatuses(
      [bill(1, 100000, 1), bill(2, 70000, 2, "void"), bill(3, 30000, 3, "draft")],
      [pay(10, 50000, 4), pay(11, 100000, 5, "void")],
      [
        { paymentId: 11, billId: 1, amountMinor: 100000 },
        { paymentId: 10, billId: 2, amountMinor: 50000 },
      ],
    );
    check(
      "void/draft bills + payments excluded",
      r.bills.length === 1 && r.payments.length === 1 && find(r, 1)?.openMinor === 50000 && find(r, 1)?.explicitMinor === 0,
      JSON.stringify(r),
    );
  }

  // 6. stale over-allocation is clamped (bill amount edited down after allocating)
  {
    const r = computeBillStatuses([bill(1, 60000, 1), bill(2, 100000, 2)], [pay(10, 100000, 3)], [
      { paymentId: 10, billId: 1, amountMinor: 100000 },
    ]);
    const p = findP(r, 10);
    check(
      "over-allocation clamped, excess flows FIFO",
      find(r, 1)?.explicitMinor === 60000 && find(r, 1)?.openMinor === 0 && p?.allocatedMinor === 60000 && find(r, 2)?.openMinor === 60000,
      JSON.stringify(r),
    );
  }

  // 7. two payments on one bill
  {
    const r = computeBillStatuses([bill(1, 1350000, 1)], [pay(10, 500000, 2), pay(11, 300000, 3)], [
      { paymentId: 10, billId: 1, amountMinor: 500000 },
    ]);
    const b = find(r, 1);
    check("two payments one bill", b?.explicitMinor === 500000 && b.autoMinor === 300000 && b.openMinor === 550000 && b.status === "partial", JSON.stringify(b));
  }

  // 8. integers only: paisa amounts never produce fractions
  {
    const r = computeBillStatuses([bill(1, 33333, 1), bill(2, 33333, 2), bill(3, 33334, 3)], [pay(10, 50001, 4)], [
      { paymentId: 10, billId: 3, amountMinor: 10001 },
    ]);
    const allInt = r.bills.every((b) => Number.isInteger(b.openMinor) && Number.isInteger(b.autoMinor));
    const sumOpen = r.bills.reduce((a, b) => a + b.openMinor, 0);
    check("integer maths, totals conserved", allInt && sumOpen === 100000 - 50001, `sumOpen=${sumOpen}`);
  }

  // 9. available-for-payment ignores other payments' FIFO shares, counts their explicit ones
  {
    const bills = [bill(1, 100000, 1)];
    const pays = [pay(10, 100000, 2), pay(11, 100000, 3)];
    const free = availableForPayment(11, bills, pays, []);
    const held = availableForPayment(11, bills, pays, [{ paymentId: 10, billId: 1, amountMinor: 60000 }]);
    const own = availableForPayment(10, bills, pays, [{ paymentId: 10, billId: 1, amountMinor: 60000 }]);
    check(
      "available: auto shares don't block, explicit ones do, own ignored",
      free.get(1) === 100000 && held.get(1) === 40000 && own.get(1) === 100000,
      `${free.get(1)}/${held.get(1)}/${own.get(1)}`,
    );
  }

  // 10. opening balance: positive is the oldest lot, negative is an advance
  {
    const pos = computeBillStatuses([bill(1, 100000, 1)], [pay(10, 150000, 2)], [], { openingMinor: 80000 });
    const neg = computeBillStatuses([bill(1, 100000, 1)], [], [], { openingMinor: -30000 });
    check(
      "opening balance first / negative opening as advance",
      pos.openingOpenMinor === 0 && find(pos, 1)?.openMinor === 30000 && find(neg, 1)?.openMinor === 70000,
      `${find(pos, 1)?.openMinor}/${find(neg, 1)?.openMinor}`,
    );
  }

  // 11. with no allocations, totals agree with the report engine's FIFO (computeOpenLots)
  {
    const bills = [bill(1, 120000, 1), bill(2, 80000, 4), bill(3, 50000, 8)];
    const pays = [pay(10, 30000, 0), pay(11, 100000, 5), pay(12, 20000, 9)];
    const r = computeBillStatuses(bills, pays, []);
    const rows: LedgerRow[] = [...bills, ...pays].map((t) => ({
      id: t.id,
      vendorId: 1,
      vendorName: "V",
      vendorPhone: null,
      currency: "PKR",
      entryType: t.entryType as "credit" | "debit",
      amountMinor: t.amountMinor,
      taxMinor: 0,
      occurredAt: t.occurredAt as Date,
      dueDate: null,
      status: t.status,
      source: "manual",
      reference: null,
      description: null,
      confidence: 100,
      messageId: null,
    }));
    const lots = computeOpenLots(rows, day(30));
    const lotTotal = lots.reduce((a, l) => a + l.remainingMinor, 0);
    const perBill = lots.every((l) => find(r, l.transactionId)?.openMinor === l.remainingMinor);
    check("matches computeOpenLots without allocations", lotTotal === r.totalOpenMinor && perBill, `lots=${lotTotal} engine=${r.totalOpenMinor}`);
  }

  // 12. payment larger than all bills with explicit part
  {
    const r = computeBillStatuses([bill(1, 50000, 1)], [pay(10, 200000, 2)], [{ paymentId: 10, billId: 1, amountMinor: 50000 }]);
    const p = findP(r, 10);
    check("explicit + surplus advance", p?.allocatedMinor === 50000 && p.unallocatedMinor === 150000 && p.advanceMinor === 150000, JSON.stringify(p));
  }

  return out;
}
