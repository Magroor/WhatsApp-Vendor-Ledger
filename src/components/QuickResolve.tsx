"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatMinor } from "@/lib/money";

type Vendor = { id: number; name: string };
type EntryType = "credit" | "debit";

/**
 * "What is this?" card for an unclear bill: the app read an amount but cannot tell
 * whether it is a bill you owe or a payment you made. Two big buttons, a vendor
 * picker when the vendor is unknown, and a one-tap save when everything else is clear.
 */
export default function QuickResolve({
  messageId,
  vendors,
  vendorId,
  vendorName,
  amountMinor,
  entryType,
  assumed,
  currency = "PKR",
  onSaved,
}: {
  messageId: number;
  vendors: Vendor[];
  vendorId: number | null;
  vendorName: string | null;
  amountMinor: number | null;
  entryType: EntryType | null;
  /** true when the app had to guess the direction (nothing on the bill says it) */
  assumed: boolean;
  currency?: string;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const vendorUnknown = !vendorId || (vendorName ?? "").startsWith("Unassigned");
  const choices = vendors.filter((v) => !v.name.startsWith("Unassigned"));

  const [type, setType] = useState<EntryType | null>(assumed ? null : entryType);
  const [vendor, setVendor] = useState<string>(vendorUnknown ? "" : String(vendorId));
  const [amountText, setAmountText] = useState<string>(amountMinor ? String(amountMinor / 100) : "");
  const [editingAmount, setEditingAmount] = useState(!amountMinor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const amountNumber = Number(amountText.replace(/,/g, ""));
  const amountOk = Number.isFinite(amountNumber) && amountNumber > 0;
  const savedVendorName = choices.find((v) => String(v.id) === vendor)?.name ?? vendorName ?? "vendor";

  async function save(chosen: EntryType) {
    if (!amountOk || !vendor) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/messages?id=${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reparse", entryType: chosen, amount: amountNumber, vendorId: Number(vendor) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save");
      if (json.posted === false) throw new Error("Could not post this entry. Check the amount.");
      setSaved(
        `${chosen === "credit" ? "Bill" : "Paid"} ${formatMinor(Math.round(amountNumber * 100), currency)} saved to ${savedVendorName}`,
      );
      onSaved?.();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function pick(chosen: EntryType) {
    setType(chosen);
    // Everything else is already known: one tap saves.
    if (!vendorUnknown && !editingAmount && amountOk) void save(chosen);
  }

  if (saved) {
    return (
      <div className="mt-2 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-200" role="status">
        ✅ {saved}
      </div>
    );
  }

  const needsSaveButton = vendorUnknown || editingAmount;

  return (
    <div className="mt-2 space-y-3 rounded-2xl border border-indigo-400/30 bg-indigo-500/10 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="tiny muted font-semibold uppercase tracking-wide">
            {assumed ? "Bill does not say if it is a bill or a payment" : "Please check this entry"}
          </p>
          {editingAmount ? (
            <div className="mt-1 flex items-center gap-2">
              <span className="text-sm">{currency}</span>
              <input
                className="field w-36"
                inputMode="decimal"
                placeholder="Amount"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                aria-label="Amount"
              />
              {amountMinor && amountOk ? (
                <button className="tiny underline" onClick={() => setEditingAmount(false)}>
                  done
                </button>
              ) : null}
            </div>
          ) : (
            <p className="mt-1 text-[22px] font-bold tabular-nums">
              {formatMinor(Math.round(amountNumber * 100), currency)}{" "}
              <button className="tiny muted underline" onClick={() => setEditingAmount(true)}>
                wrong? edit
              </button>
            </p>
          )}
        </div>
      </div>

      <div>
        <p className="label mb-1">What is this?</p>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Entry type">
          <button
            type="button"
            aria-pressed={type === "credit"}
            disabled={busy || !amountOk}
            onClick={() => pick("credit")}
            className={`rounded-2xl border p-3 text-left transition-colors ${
              type === "credit" ? "border-emerald-400 bg-emerald-500/20" : "border-white/15 bg-white/5"
            }`}
          >
            <span className="block text-xl">🧾</span>
            <span className="block text-[15px] font-semibold">Bill</span>
            <span className="tiny muted block">I owe this (credit)</span>
          </button>
          <button
            type="button"
            aria-pressed={type === "debit"}
            disabled={busy || !amountOk}
            onClick={() => pick("debit")}
            className={`rounded-2xl border p-3 text-left transition-colors ${
              type === "debit" ? "border-rose-400 bg-rose-500/20" : "border-white/15 bg-white/5"
            }`}
          >
            <span className="block text-xl">💸</span>
            <span className="block text-[15px] font-semibold">Paid</span>
            <span className="tiny muted block">I paid this (debit)</span>
          </button>
        </div>
      </div>

      {vendorUnknown ? (
        <div>
          <label className="label" htmlFor={`vendor-${messageId}`}>
            Which vendor?
          </label>
          <select id={`vendor-${messageId}`} className="field mt-1" value={vendor} onChange={(e) => setVendor(e.target.value)}>
            <option value="">Choose a vendor…</option>
            {choices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="tiny muted">Vendor: {vendorName}</p>
      )}

      {needsSaveButton ? (
        <button
          className="btn btn-primary w-full"
          disabled={busy || !type || !vendor || !amountOk}
          onClick={() => type && save(type)}
        >
          {busy ? "Saving…" : !type ? "Choose Bill or Paid" : !vendor ? "Choose the vendor" : "✔ Save to ledger"}
        </button>
      ) : (
        <p className="tiny muted">{busy ? "Saving…" : "Tap Bill or Paid to save."}</p>
      )}
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
    </div>
  );
}
