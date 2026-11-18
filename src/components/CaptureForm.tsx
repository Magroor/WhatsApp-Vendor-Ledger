"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type VendorOption = { id: number; name: string; phone: string | null };

type Outcome = {
  status: string;
  confidence: number;
  transactionId: number | null;
  vendorId: number | null;
  note?: string;
};

const SAMPLES = [
  "Ahmed Traders\nBill #1042 - 12 Feb\n5 bags cement @ 1480\n3 boxes fittings @ 900\nTotal 10100 udhaar",
  "Payment received via easypaisa Rs 8,000 against bill #1042",
  "Bilal Steel\nChallan #A-229\n10 saria bundles @ 128000\nTotal 128000 udhaar",
  "add 5 bags of cement on credit for Ahmed total 7500",
];

export default function CaptureForm({
  vendors,
  autoOpen,
}: {
  vendors: VendorOption[];
  autoOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(Boolean(autoOpen));
  const [text, setText] = useState("");
  const [vendorId, setVendorId] = useState<string>("");
  const [phone, setPhone] = useState("");
  const [messageType, setMessageType] = useState("text");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setOutcome(null);
    const selected = vendors.find((v) => String(v.id) === vendorId);
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          messageType,
          from: selected?.phone ?? phone,
          profileName: selected?.name,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Capture failed");
      setOutcome(json as Outcome);
      setText("");
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
        ➕ Capture WhatsApp message
      </button>
    );
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <p className="h2">Capture a bill</p>
        <button className="tiny muted" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <p className="tiny muted">
        Paste or forward the exact WhatsApp text the vendor sent. The parser reads the
        total, items, bill number, date and whether it is credit (udhaar) or debit
        (payment) — then posts the ledger entry.
      </p>

      <div>
        <label className="label">Message text</label>
        <textarea
          className="field"
          rows={7}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Ahmed Traders\nBill #1042\n5 bags cement @ 1480\nTotal 10100 udhaar"}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {SAMPLES.map((sample, i) => (
          <button
            key={i}
            className="chip"
            onClick={() => {
              setText(sample);
              setMessageType(sample.toLowerCase().includes("payment") ? "text" : "text");
            }}
          >
            Sample {i + 1}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Link to vendor</label>
          <select className="field" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="" className="bg-slate-900">
              Auto-detect by number
            </option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id} className="bg-slate-900">
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Message type</label>
          <select className="field" value={messageType} onChange={(e) => setMessageType(e.target.value)}>
            <option value="text" className="bg-slate-900">text</option>
            <option value="image" className="bg-slate-900">image (bill photo)</option>
            <option value="audio" className="bg-slate-900">voice note</option>
            <option value="document" className="bg-slate-900">document</option>
          </select>
        </div>
      </div>

      {vendorId === "" ? (
        <div>
          <label className="label">Sender WhatsApp number (for auto-create)</label>
          <input
            className="field"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="923211234501"
          />
        </div>
      ) : null}

      {error ? <p className="tiny money-neg">{error}</p> : null}

      {outcome ? (
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <p className="tiny muted">Parser result</p>
          <p className="mt-1 text-[14px] font-semibold">
            {outcome.status === "parsed"
              ? `✅ Auto-posted entry #${outcome.transactionId}`
              : outcome.status === "review"
                ? "🔎 Saved for review — low confidence or missing amount"
                : `ℹ︎ ${outcome.status}${outcome.note ? ` (${outcome.note})` : ""}`}
          </p>
          <p className="tiny muted mt-1">confidence {outcome.confidence}%</p>
        </div>
      ) : null}

      <button className="btn btn-primary w-full" onClick={submit} disabled={busy || !text.trim()}>
        {busy ? "Parsing…" : "Parse & post to ledger"}
      </button>
    </div>
  );
}
