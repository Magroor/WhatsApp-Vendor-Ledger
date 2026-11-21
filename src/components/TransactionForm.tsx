"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type ItemRow = { name: string; qty: string; unit: string; unitPrice: string };

export default function TransactionForm({
  vendorId,
  currency,
  termsDays,
}: {
  vendorId: number;
  currency: string;
  termsDays: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entryType, setEntryType] = useState<"credit" | "debit">("credit");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [paymentMode, setPaymentMode] = useState("");
  // Local date: UTC would pre-fill yesterday between midnight and 5 am in Asia.
  const [occurredAt, setOccurredAt] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [items, setItems] = useState<ItemRow[]>([]);

  function addItem() {
    setItems((rows) => [...rows, { name: "", qty: "1", unit: "", unitPrice: "" }]);
  }
  function updateItem(index: number, patch: Partial<ItemRow>) {
    setItems((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function submit(status: "confirmed" | "draft") {
    setError(null);
    const cleaned = amount.trim().replace(/,/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned) || Number(cleaned) <= 0) {
      setError("Enter the amount as a positive number, like 7500 or 1250.50.");
      return;
    }
    if (Number(cleaned) > 100_000_000_000) {
      setError("That amount is too large. Check the zeros.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorId,
          entryType,
          amount: cleaned,
          reference: reference || undefined,
          description: description || undefined,
          paymentMode: entryType === "debit" ? paymentMode || undefined : undefined,
          occurredAt: new Date(`${occurredAt}T12:00:00`).toISOString(),
          status,
          items: items
            .filter((i) => i.name.trim())
            .map((i) => ({ name: i.name, qty: Number(i.qty) || 1, unit: i.unit || undefined, unitPrice: i.unitPrice || undefined })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save entry");
      setAmount("");
      setReference("");
      setDescription("");
      setPaymentMode("");
      setItems([]);
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn btn-primary w-full" onClick={() => setOpen(true)}>
        ✍️ Add entry manually
      </button>
    );
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <p className="h2">New ledger entry</p>
        <button className="tiny muted" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          className={`btn ${entryType === "credit" ? "btn-credit" : ""}`}
          onClick={() => setEntryType("credit")}
        >
          Credit (billed)
        </button>
        <button
          className={`btn ${entryType === "debit" ? "btn-debit" : ""}`}
          onClick={() => setEntryType("debit")}
        >
          Debit (paid)
        </button>
      </div>

      <div>
        <label className="label">Amount ({currency})</label>
        <input
          className="field"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="15000"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Date</label>
          <input aria-label="Date" className="field" type="date" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </div>
        <div>
          <label className="label">Bill / ref #</label>
          <input aria-label="Bill / ref #" className="field" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="1042" />
        </div>
      </div>

      {entryType === "debit" ? (
        <div>
          <label className="label">Payment mode</label>
          <select aria-label="Payment mode" className="field" value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}>
            <option value="" className="bg-slate-900">Select</option>
            {["cash", "bank", "easypaisa", "jazzcash", "cheque", "card", "upi"].map((m) => (
              <option key={m} value={m} className="bg-slate-900">
                {m}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="tiny muted">
          Due date auto-set to Net-{termsDays} from the bill date.
        </p>
      )}

      <div>
        <label className="label">Note</label>
        <input aria-label="Note"
          className="field"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Cement supply for March"
        />
      </div>

      {items.length ? (
        <div className="space-y-2">
          <label className="label">Order items</label>
          {items.map((item, index) => (
            <div key={index} className="grid grid-cols-[1fr_52px_58px_72px] gap-1">
              <input className="field" value={item.name} onChange={(e) => updateItem(index, { name: e.target.value })} placeholder="Item" />
              <input className="field" inputMode="decimal" value={item.qty} onChange={(e) => updateItem(index, { qty: e.target.value })} placeholder="Qty" />
              <input className="field" value={item.unit} onChange={(e) => updateItem(index, { unit: e.target.value })} placeholder="Unit" />
              <input className="field" inputMode="decimal" value={item.unitPrice} onChange={(e) => updateItem(index, { unitPrice: e.target.value })} placeholder="Rate" />
            </div>
          ))}
        </div>
      ) : null}

      <button className="btn btn-sm" onClick={addItem}>
        ➕ Add item line
      </button>

      {error ? <p className="tiny money-neg">{error}</p> : null}

      <div className="grid grid-cols-2 gap-2">
        <button className="btn btn-primary" onClick={() => submit("confirmed")} disabled={busy}>
          {busy ? "Saving…" : "Post entry"}
        </button>
        <button className="btn" onClick={() => submit("draft")} disabled={busy}>
          Save as draft
        </button>
      </div>
    </div>
  );
}
