/**
 * Party kinds. Vendors and customers share the same ledger maths:
 *   credit = a bill / sale on credit (balance grows), debit = a payment (balance shrinks).
 * Vendor balance > 0 means we owe them; customer balance > 0 means they owe us.
 */
export type PartyKind = "vendor" | "customer";

export const PARTY_KINDS: readonly PartyKind[] = ["vendor", "customer"] as const;

export type KindLabels = {
  kind: PartyKind;
  noun: "Vendor" | "Customer";
  nounLower: "vendor" | "customer";
  nounPlural: "Vendors" | "Customers";
  creditTitle: "Bill" | "Sale on credit";
  creditHint: "I owe this" | "they owe me";
  debitTitle: "Paid" | "Payment received";
  debitHint: "I paid them" | "they paid me";
  balanceLabel: "You owe" | "They owe you";
  /** Label when the balance is negative (an advance / overpayment). */
  advanceLabel: "They owe you (advance)" | "You owe them (advance)";
  khataTitle: "Vendor khata" | "Customer khata";
};

/** Anything that is not exactly "customer" is treated as a vendor (the column default). */
export function normalizeKind(kind: unknown): PartyKind {
  return kind === "customer" ? "customer" : "vendor";
}

export function labelsFor(kind: unknown): KindLabels {
  if (normalizeKind(kind) === "customer") {
    return {
      kind: "customer",
      noun: "Customer",
      nounLower: "customer",
      nounPlural: "Customers",
      creditTitle: "Sale on credit",
      creditHint: "they owe me",
      debitTitle: "Payment received",
      debitHint: "they paid me",
      balanceLabel: "They owe you",
      advanceLabel: "You owe them (advance)",
      khataTitle: "Customer khata",
    };
  }
  return {
    kind: "vendor",
    noun: "Vendor",
    nounLower: "vendor",
    nounPlural: "Vendors",
    creditTitle: "Bill",
    creditHint: "I owe this",
    debitTitle: "Paid",
    debitHint: "I paid them",
    balanceLabel: "You owe",
    advanceLabel: "They owe you (advance)",
    khataTitle: "Vendor khata",
  };
}

export type BalanceSplit = {
  /** What we owe vendors (positive vendor balances). */
  payableMinor: number;
  /** What customers owe us (positive customer balances). */
  receivableMinor: number;
  /** Vendors we have overpaid / paid in advance (negative vendor balances, as a positive number). */
  vendorAdvanceMinor: number;
  /** Customers who paid us in advance (negative customer balances, as a positive number). */
  customerAdvanceMinor: number;
};

/** Pure: split party balances (integer minor units) into payable / receivable / advances. */
export function splitBalances(rows: ReadonlyArray<{ kind?: unknown; balanceMinor: number }>): BalanceSplit {
  const out: BalanceSplit = { payableMinor: 0, receivableMinor: 0, vendorAdvanceMinor: 0, customerAdvanceMinor: 0 };
  for (const r of rows) {
    const b = Math.round(Number(r.balanceMinor) || 0);
    if (b === 0) continue;
    if (normalizeKind(r.kind) === "customer") {
      if (b > 0) out.receivableMinor += b;
      else out.customerAdvanceMinor += -b;
    } else if (b > 0) out.payableMinor += b;
    else out.vendorAdvanceMinor += -b;
  }
  return out;
}
