"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatMinor } from "@/lib/money";
import type { PayPlan } from "@/lib/planner";

const MODES = [
  { value: "cash", label: "Cash" },
  { value: "bank", label: "Bank" },
  { value: "easypaisa", label: "Easypaisa" },
  { value: "jazzcash", label: "JazzCash" },
];

function toDecimal(minor: number): string {
  const abs = Math.abs(minor);
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function PayForm({ vendorId, dueNowMinor, onDone }: { vendorId: number; dueNowMinor: number; onDone: () => void }) {
  const router = useRouter();
  const [amount, setAmount] = useState(toDecimal(dueNowMinor));
  const [mode, setMode] = useState("cash");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const cleaned = amount.replace(/,/g, "").trim();
    const n = Number(cleaned);
    if (!cleaned || !Number.isFinite(n) || n <= 0) {
      setError("Enter an amount greater than 0");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          vendorId,
          entryType: "debit",
          amount: cleaned,
          paymentMode: mode,
          description: "Paid from pay planner",
          status: "confirmed",
        }),
      });
      if (!res.ok) {
        let msg = `Failed (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string; message?: string };
          msg = j.error || j.message || msg;
        } catch {
          /* keep default */
        }
        setError(msg);
        setBusy(false);
        return;
      }
      onDone();
      router.refresh();
    } catch {
      setError("Network error, try again");
    }
    setBusy(false);
  }

  return (
    <div className="mt-2 space-y-2 rounded-xl border border-white/10 p-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="label">Amount</span>
          <input
            className="field"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Payment amount"
          />
        </label>
        <label className="block">
          <span className="label">Mode</span>
          <select className="field" value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Payment mode">
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <p className="tiny money-neg" role="alert">
          {error}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn btn-sm" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={submit} disabled={busy}>
          {busy ? "Saving…" : "Confirm"}
        </button>
      </div>
    </div>
  );
}

export default function PayThisWeek({ plan }: { plan: PayPlan }) {
  const [openId, setOpenId] = useState<number | null>(null);
  if (!plan.vendors.length) return null;
  const shown = plan.vendors.slice(0, 5);
  const more = plan.vendors.length - shown.length;

  return (
    <section className="card border-amber-400/30 bg-amber-400/5" aria-label="Pay this week">
      <p className="tiny muted font-semibold uppercase tracking-wide">Pay this week</p>
      <p className="h2 mt-1">Needed this week: {formatMinor(plan.neededThisWeekMinor, plan.currency)}</p>
      {plan.overdueMinor > 0 ? (
        <p className="tiny money-neg mt-0.5">{formatMinor(plan.overdueMinor, plan.currency)} already overdue</p>
      ) : null}
      <ul className="mt-3 space-y-3">
        {shown.map((v) => (
          <li key={v.vendorId}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold">{v.vendorName}</p>
                <p className={`tiny ${v.daysOverdue > 0 ? "money-neg" : "muted"}`}>{v.label}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-[15px] font-bold tabular-nums">{formatMinor(v.dueNowMinor, v.currency)}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-expanded={openId === v.vendorId}
                  onClick={() => setOpenId(openId === v.vendorId ? null : v.vendorId)}
                >
                  Mark paid
                </button>
              </div>
            </div>
            {openId === v.vendorId ? (
              <PayForm vendorId={v.vendorId} dueNowMinor={v.dueNowMinor} onDone={() => setOpenId(null)} />
            ) : null}
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="tiny muted mt-3">+ {more} more vendor{more === 1 ? "" : "s"} due this week</p> : null}
    </section>
  );
}
