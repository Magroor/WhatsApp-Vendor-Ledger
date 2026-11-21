/**
 * Pure bill-settlement engine (no DB imports, safe for self-tests and type-only client imports).
 *
 * Rules:
 *  - Only status "confirmed" rows count. credit = bill, debit = payment.
 *  - Explicit allocations (payment_allocations) are applied first, each clamped to what is still
 *    open on the bill and still unspent on the payment (stale rows after a void / amount edit can
 *    therefore never over-count; the excess flows back to the payment's unallocated remainder).
 *  - Then every payment's UNALLOCATED remainder settles still-open bills oldest-first (FIFO),
 *    payments taken in date order. A positive opening balance is the oldest lot; a negative one is
 *    an advance that settles bills before any payment remainder.
 *  - Whatever cannot be placed on a bill is an advance (surplus).
 *  - All maths is on integer minor units.
 */

export type AllocTx = {
  id: number;
  vendorId?: number;
  entryType: string; // credit | debit
  amountMinor: number;
  occurredAt: Date | string;
  status: string;
  reference?: string | null;
  dueDate?: string | null;
};

export type AllocRow = {
  id?: number;
  paymentId: number;
  billId: number;
  amountMinor: number;
};

export type BillState = "open" | "partial" | "settled";

export type BillStatus = {
  billId: number;
  occurredAt: string;
  reference: string | null;
  dueDate: string | null;
  originalMinor: number;
  explicitMinor: number;
  autoMinor: number;
  openMinor: number;
  status: BillState;
};

export type PaymentStatus = {
  paymentId: number;
  occurredAt: string;
  reference: string | null;
  amountMinor: number;
  /** Explicit allocations that actually landed on confirmed bills. */
  allocatedMinor: number;
  /** amountMinor - allocatedMinor (settles oldest bills automatically). */
  unallocatedMinor: number;
  /** Part of the unallocated remainder that FIFO placed on bills / opening balance. */
  autoMinor: number;
  /** Part that found no open bill at all (advance / overpayment). */
  advanceMinor: number;
};

export type BillStatusResult = {
  bills: BillStatus[];
  payments: PaymentStatus[];
  /** Opening balance still owed after FIFO (0 when none). */
  openingOpenMinor: number;
  /** Money paid in advance that no bill has absorbed yet (payments + negative opening). */
  advanceMinor: number;
  /** Sum of bill openMinor + openingOpenMinor. */
  totalOpenMinor: number;
};

const toInt = (n: unknown): number => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? v : 0;
};

const timeOf = (d: Date | string): number => {
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? t : 0;
};

const isoOf = (d: Date | string): string => {
  const t = timeOf(d);
  return new Date(t).toISOString();
};

const byDate = (a: AllocTx, b: AllocTx) => timeOf(a.occurredAt) - timeOf(b.occurredAt) || a.id - b.id;

export function computeBillStatuses(
  bills: AllocTx[],
  payments: AllocTx[],
  allocations: AllocRow[],
  options: { openingMinor?: number } = {},
): BillStatusResult {
  // Accept mixed input: filter each list by type + confirmed status (void / draft excluded).
  const confirmedBills = bills
    .filter((b) => b.status === "confirmed" && b.entryType === "credit" && toInt(b.amountMinor) > 0)
    .sort(byDate);
  const confirmedPays = payments
    .filter((p) => p.status === "confirmed" && p.entryType === "debit" && toInt(p.amountMinor) > 0)
    .sort(byDate);

  const billById = new Map(confirmedBills.map((b) => [b.id, b]));
  const payById = new Map(confirmedPays.map((p) => [p.id, p]));
  const billOrder = new Map(confirmedBills.map((b, i) => [b.id, i]));
  const payOrder = new Map(confirmedPays.map((p, i) => [p.id, i]));

  const billRemaining = new Map(confirmedBills.map((b) => [b.id, toInt(b.amountMinor)]));
  const payRemaining = new Map(confirmedPays.map((p) => [p.id, toInt(p.amountMinor)]));
  const explicit = new Map<number, number>();
  const auto = new Map<number, number>();
  const payAllocated = new Map<number, number>();
  const payAuto = new Map<number, number>();

  // 1) explicit allocations, in payment date order then bill date order (deterministic clamping).
  const validAllocs = allocations
    .filter((a) => {
      const p = payById.get(a.paymentId);
      const b = billById.get(a.billId);
      if (!p || !b) return false;
      if (p.vendorId !== undefined && b.vendorId !== undefined && p.vendorId !== b.vendorId) return false;
      return toInt(a.amountMinor) > 0;
    })
    .sort(
      (x, y) =>
        (payOrder.get(x.paymentId) ?? 0) - (payOrder.get(y.paymentId) ?? 0) ||
        (billOrder.get(x.billId) ?? 0) - (billOrder.get(y.billId) ?? 0) ||
        (x.id ?? 0) - (y.id ?? 0),
    );
  for (const a of validAllocs) {
    const apply = Math.min(toInt(a.amountMinor), billRemaining.get(a.billId) ?? 0, payRemaining.get(a.paymentId) ?? 0);
    if (apply <= 0) continue;
    billRemaining.set(a.billId, (billRemaining.get(a.billId) ?? 0) - apply);
    payRemaining.set(a.paymentId, (payRemaining.get(a.paymentId) ?? 0) - apply);
    explicit.set(a.billId, (explicit.get(a.billId) ?? 0) + apply);
    payAllocated.set(a.paymentId, (payAllocated.get(a.paymentId) ?? 0) + apply);
  }

  // 2) FIFO of unallocated remainders over open lots (opening balance first, then bills by date).
  const opening = toInt(options.openingMinor ?? 0);
  let openingRemaining = opening > 0 ? opening : 0;
  let negativeOpeningAdvance = opening < 0 ? -opening : 0;
  let lotIdx = 0; // index into confirmedBills; opening handled before it

  const place = (amount: number, onBill: (billId: number, take: number) => void): number => {
    let left = amount;
    if (left > 0 && openingRemaining > 0) {
      const take = Math.min(left, openingRemaining);
      openingRemaining -= take;
      left -= take;
    }
    while (left > 0 && lotIdx < confirmedBills.length) {
      const bill = confirmedBills[lotIdx];
      const rem = billRemaining.get(bill.id) ?? 0;
      if (rem <= 0) {
        lotIdx += 1;
        continue;
      }
      const take = Math.min(left, rem);
      billRemaining.set(bill.id, rem - take);
      auto.set(bill.id, (auto.get(bill.id) ?? 0) + take);
      onBill(bill.id, take);
      left -= take;
    }
    return left;
  };

  // Advance from a negative opening balance pays bills only (it is not a payment row).
  negativeOpeningAdvance = (() => {
    const savedOpening = openingRemaining;
    openingRemaining = 0;
    const left = place(negativeOpeningAdvance, () => {});
    openingRemaining = savedOpening;
    return left;
  })();

  const payAdvance = new Map<number, number>();
  for (const p of confirmedPays) {
    const remainder = payRemaining.get(p.id) ?? 0;
    if (remainder <= 0) continue;
    const beforeOpening = openingRemaining;
    let toBills = 0;
    const left = place(remainder, (_b, take) => {
      toBills += take;
    });
    const toOpening = beforeOpening - openingRemaining;
    payAuto.set(p.id, toBills + toOpening);
    payAdvance.set(p.id, left);
  }

  const billsOut: BillStatus[] = confirmedBills.map((b) => {
    const original = toInt(b.amountMinor);
    const open = billRemaining.get(b.id) ?? 0;
    return {
      billId: b.id,
      occurredAt: isoOf(b.occurredAt),
      reference: b.reference ?? null,
      dueDate: b.dueDate ?? null,
      originalMinor: original,
      explicitMinor: explicit.get(b.id) ?? 0,
      autoMinor: auto.get(b.id) ?? 0,
      openMinor: open,
      status: open <= 0 ? "settled" : open < original ? "partial" : "open",
    };
  });

  const paymentsOut: PaymentStatus[] = confirmedPays.map((p) => {
    const amount = toInt(p.amountMinor);
    const allocated = payAllocated.get(p.id) ?? 0;
    return {
      paymentId: p.id,
      occurredAt: isoOf(p.occurredAt),
      reference: p.reference ?? null,
      amountMinor: amount,
      allocatedMinor: allocated,
      unallocatedMinor: amount - allocated,
      autoMinor: payAuto.get(p.id) ?? 0,
      advanceMinor: payAdvance.get(p.id) ?? 0,
    };
  });

  const advanceMinor = negativeOpeningAdvance + paymentsOut.reduce((a, p) => a + p.advanceMinor, 0);
  const totalOpenMinor = billsOut.reduce((a, b) => a + b.openMinor, 0) + openingRemaining;
  return { bills: billsOut, payments: paymentsOut, openingOpenMinor: openingRemaining, advanceMinor, totalOpenMinor };
}

/**
 * How much payment `paymentId` may explicitly put on each bill: the bill amount minus what OTHER
 * confirmed payments have explicitly allocated to it (this payment's own previous allocation is
 * ignored because a POST replaces it). Automatic FIFO shares of other payments do not block it:
 * explicit allocations take precedence and those remainders simply move to the next open bill.
 * Used by the POST validation, the panel's "can apply" column and the Auto button.
 */
export function availableForPayment(
  paymentId: number,
  bills: AllocTx[],
  payments: AllocTx[],
  allocations: AllocRow[],
  options: { openingMinor?: number } = {},
): Map<number, number> {
  const res = computeBillStatuses(
    bills,
    payments.filter((p) => p.id !== paymentId),
    allocations.filter((a) => a.paymentId !== paymentId),
    options,
  );
  return new Map(res.bills.map((b) => [b.billId, Math.max(0, b.originalMinor - b.explicitMinor)]));
}

/** Oldest-first fill of `budget` across bills (in the given order) capped by `available`. */
export function autoFill(
  billIdsOldestFirst: number[],
  available: Map<number, number>,
  budget: number,
): Map<number, number> {
  const out = new Map<number, number>();
  let left = Math.max(0, Math.round(budget));
  for (const id of billIdsOldestFirst) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, available.get(id) ?? 0));
    if (take > 0) {
      out.set(id, take);
      left -= take;
    }
  }
  return out;
}
