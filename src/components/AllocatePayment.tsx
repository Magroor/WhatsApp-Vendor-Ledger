"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { formatMinor } from "@/lib/money";
import type { BillStatus } from "@/lib/allocations-core";

type ForPayment = {
  paymentId: number;
  amountMinor: number;
  allocations: Array<{ billId: number; amountMinor: number }>;
  available: Array<{ billId: number; availableMinor: number }>;
};

type Row = { bill: BillStatus; availableMinor: number };

/** "1,500.5" -> 150050; null when not a plain amount with at most 2 decimals. */
function parseMinor(text: string): number | null {
  const s = text.replace(/[,\s]/g, "");
  if (!s) return 0;
  const m = s.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

const minorToInput = (minor: number) => {
  const whole = Math.floor(minor / 100);
  const frac = minor % 100;
  return frac ? `${whole}.${String(frac).padStart(2, "0")}` : String(whole);
};

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });

/** "Apply to bills" for a payment (debit) entry: split the payment across the vendor's open bills. */
export default function AllocatePayment({
  paymentId,
  vendorId,
  currency,
  amountMinor,
  allocatedMinor = 0,
}: {
  paymentId: number;
  vendorId: number;
  currency: string;
  amountMinor: number;
  allocatedMinor?: number;
}) {
  const router = useRouter();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [values, setValues] = useState<Record<number, string>>({});
  const [hadAllocations, setHadAllocations] = useState(allocatedMinor > 0);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/allocations?vendorId=${vendorId}&paymentId=${paymentId}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not load bills.");
      const fp = json.forPayment as ForPayment;
      const avail = new Map(fp.available.map((a) => [a.billId, a.availableMinor]));
      const mine = new Map(fp.allocations.map((a) => [a.billId, a.amountMinor]));
      const list: Row[] = (json.bills as BillStatus[])
        .map((bill) => ({ bill, availableMinor: avail.get(bill.billId) ?? 0 }))
        .filter((r) => r.availableMinor > 0 || mine.has(r.bill.billId));
      setRows(list);
      setValues(Object.fromEntries(list.map((r) => [r.bill.billId, mine.has(r.bill.billId) ? minorToInput(mine.get(r.bill.billId) ?? 0) : ""])));
      setHadAllocations(fp.allocations.length > 0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void load();
  }

  const parsed = rows.map((r) => ({ r, minor: parseMinor(values[r.bill.billId] ?? "") }));
  const total = parsed.reduce((a, p) => a + (p.minor ?? 0), 0);
  const left = amountMinor - total;
  const rowError = (p: (typeof parsed)[number]) =>
    p.minor === null
      ? "Enter an amount like 1500 or 1500.50"
      : p.minor > p.r.availableMinor
        ? `Max ${formatMinor(p.r.availableMinor, currency)}`
        : null;
  const invalid = parsed.some((p) => rowError(p) !== null) || left < 0;

  function autoFill() {
    let budget = amountMinor;
    const next: Record<number, string> = {};
    for (const r of rows) {
      const take = Math.max(0, Math.min(budget, r.availableMinor));
      next[r.bill.billId] = take > 0 ? minorToInput(take) : "";
      budget -= take;
    }
    setValues(next);
  }

  async function send(init: RequestInit, url: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, init);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "That did not work. Please try again.");
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (invalid) return;
    const allocations = parsed
      .filter((p) => (p.minor ?? 0) > 0)
      .map((p) => ({ billId: p.r.bill.billId, amount: minorToInput(p.minor ?? 0) }));
    void send(
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paymentId, allocations }) },
      "/api/allocations",
    );
  }

  function clear() {
    void send({ method: "DELETE" }, `/api/allocations?paymentId=${paymentId}`);
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        className="btn btn-sm"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`${uid}-panel`}
      >
        {open ? "Close" : allocatedMinor > 0 ? `Applied ${formatMinor(allocatedMinor, currency)} · edit` : "Apply to bills"}
      </button>

      {open ? (
        <div id={`${uid}-panel`} className="mt-2 rounded-xl border border-white/10 p-3 space-y-3" role="region" aria-label="Apply payment to bills">
          {loading ? <p className="tiny muted">Loading bills…</p> : null}

          {!loading && rows.length === 0 && !error ? (
            <p className="tiny muted">No open bills to apply this payment to.</p>
          ) : null}

          {!loading && rows.length > 0 ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className={`text-[13px] font-semibold ${left < 0 ? "money-neg" : ""}`} aria-live="polite">
                  {left < 0
                    ? `${formatMinor(-left, currency)} too much`
                    : `${formatMinor(left, currency)} left to apply`}
                </p>
                <button type="button" className="btn btn-sm" onClick={autoFill} disabled={busy}>
                  Auto: oldest first
                </button>
              </div>

              <div className="space-y-2">
                {parsed.map((p) => {
                  const b = p.r.bill;
                  const inputId = `${uid}-bill-${b.billId}`;
                  const err = rowError(p);
                  return (
                    <div key={b.billId}>
                      <label htmlFor={inputId} className="label">
                        {shortDate(b.occurredAt)} · {b.reference ? `#${b.reference}` : `Bill ${b.billId}`}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          id={inputId}
                          className="field"
                          inputMode="decimal"
                          placeholder="0"
                          value={values[b.billId] ?? ""}
                          onChange={(e) => setValues((v) => ({ ...v, [b.billId]: e.target.value }))}
                          aria-invalid={err ? true : undefined}
                          aria-describedby={`${inputId}-hint`}
                        />
                      </div>
                      <p id={`${inputId}-hint`} className={`tiny mt-1 ${err ? "money-neg" : "muted"}`}>
                        {err ??
                          `Can apply up to ${formatMinor(p.r.availableMinor, currency)} · open ${formatMinor(b.openMinor, currency)} of ${formatMinor(b.originalMinor, currency)}`}
                      </p>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          {error ? (
            <p className="tiny money-neg" role="alert">
              {error}
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-sm" onClick={clear} disabled={busy || loading || !hadAllocations}>
              Clear
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={save}
              disabled={busy || loading || invalid || rows.length === 0}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="tiny muted">Any amount you do not apply settles the oldest bills automatically.</p>
        </div>
      ) : null}
    </div>
  );
}
