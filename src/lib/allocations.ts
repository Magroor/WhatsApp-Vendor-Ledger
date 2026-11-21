import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { paymentAllocations, transactions, vendors } from "@/db/schema";
import {
  availableForPayment,
  computeBillStatuses,
  type AllocRow,
  type AllocTx,
  type BillStatusResult,
} from "./allocations-core";

export {
  autoFill,
  availableForPayment,
  computeBillStatuses,
  type AllocRow,
  type AllocTx,
  type BillState,
  type BillStatus,
  type BillStatusResult,
  type PaymentStatus,
} from "./allocations-core";

/** db itself or a transaction handle (anything with the query builder's select). */
export type DbExec = Pick<typeof db, "select">;

export type AllocationInputs = {
  vendorId: number;
  currency: string;
  openingMinor: number;
  bills: AllocTx[];
  payments: AllocTx[];
  allocations: AllocRow[];
};

/** Loads a vendor's confirmed bills/payments and the allocations between them. Null if no vendor. */
export async function loadAllocationInputs(vendorId: number, exec: DbExec = db): Promise<AllocationInputs | null> {
  const v = await exec
    .select({ currency: vendors.currency, opening: vendors.openingBalanceMinor })
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .limit(1);
  if (!v[0]) return null;

  const rows = await exec
    .select({
      id: transactions.id,
      vendorId: transactions.vendorId,
      entryType: transactions.entryType,
      amountMinor: transactions.amountMinor,
      occurredAt: transactions.occurredAt,
      status: transactions.status,
      reference: transactions.reference,
      dueDate: transactions.dueDate,
    })
    .from(transactions)
    .where(and(eq(transactions.vendorId, vendorId), eq(transactions.status, "confirmed")));

  const txs: AllocTx[] = rows.map((r) => ({ ...r, amountMinor: Number(r.amountMinor) }));
  const paymentIds = txs.filter((t) => t.entryType === "debit").map((t) => t.id);
  const allocRows = paymentIds.length
    ? await exec
        .select({
          id: paymentAllocations.id,
          paymentId: paymentAllocations.paymentId,
          billId: paymentAllocations.billId,
          amountMinor: paymentAllocations.amountMinor,
        })
        .from(paymentAllocations)
        .where(inArray(paymentAllocations.paymentId, paymentIds))
    : [];

  return {
    vendorId,
    currency: v[0].currency,
    openingMinor: Number(v[0].opening ?? 0),
    bills: txs.filter((t) => t.entryType === "credit"),
    payments: txs.filter((t) => t.entryType === "debit"),
    allocations: allocRows.map((a) => ({ ...a, amountMinor: Number(a.amountMinor) })),
  };
}

export type VendorBillStatuses = BillStatusResult & {
  vendorId: number;
  currency: string;
  /** Raw explicit allocation rows (confirmed payments only) for UI prefill. */
  allocations: AllocRow[];
};

/** Bill / payment settlement status for one vendor, computed from confirmed rows only. */
export async function loadBillStatuses(vendorId: number, exec: DbExec = db): Promise<VendorBillStatuses | null> {
  const input = await loadAllocationInputs(vendorId, exec);
  if (!input) return null;
  const res = computeBillStatuses(input.bills, input.payments, input.allocations, { openingMinor: input.openingMinor });
  return { ...res, vendorId, currency: input.currency, allocations: input.allocations };
}

/** Per-bill amount a given payment may still claim (see availableForPayment). */
export function availableFromInputs(paymentId: number, input: AllocationInputs): Map<number, number> {
  return availableForPayment(paymentId, input.bills, input.payments, input.allocations, {
    openingMinor: input.openingMinor,
  });
}
