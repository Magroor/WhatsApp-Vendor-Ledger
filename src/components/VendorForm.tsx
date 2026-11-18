"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const CURRENCIES = ["PKR", "INR", "USD", "AED", "SAR", "BDT", "LKR", "GBP", "EUR"];

export default function VendorForm({ open = false }: { open?: boolean }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(open);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    phone: "",
    businessType: "",
    city: "",
    currency: "PKR",
    creditTermsDays: 30,
    openingBalance: "",
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/vendors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save vendor");
      setForm({
        name: "",
        phone: "",
        businessType: "",
        city: "",
        currency: "PKR",
        creditTermsDays: 30,
        openingBalance: "",
      });
      setExpanded(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!expanded) {
    return (
      <button className="btn btn-primary w-full" onClick={() => setExpanded(true)}>
        ➕ Add vendor
      </button>
    );
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <p className="h2">New vendor khata</p>
        <button className="tiny muted" onClick={() => setExpanded(false)}>
          Cancel
        </button>
      </div>
      <div>
        <label className="label">Vendor / shop name</label>
        <input
          className="field"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Ahmed Traders"
        />
      </div>
      <div>
        <label className="label">WhatsApp number (with country code)</label>
        <input
          className="field"
          inputMode="tel"
          value={form.phone}
          onChange={(e) => set("phone", e.target.value)}
          placeholder="923211234501"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Business type</label>
          <input
            className="field"
            value={form.businessType}
            onChange={(e) => set("businessType", e.target.value)}
            placeholder="Hardware"
          />
        </div>
        <div>
          <label className="label">City</label>
          <input
            className="field"
            value={form.city}
            onChange={(e) => set("city", e.target.value)}
            placeholder="Lahore"
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="label">Currency</label>
          <select className="field" value={form.currency} onChange={(e) => set("currency", e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c} className="bg-slate-900">
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Terms</label>
          <input
            className="field"
            inputMode="numeric"
            value={form.creditTermsDays}
            onChange={(e) => set("creditTermsDays", Number(e.target.value) || 0)}
          />
        </div>
        <div>
          <label className="label">Opening</label>
          <input
            className="field"
            inputMode="decimal"
            value={form.openingBalance}
            onChange={(e) => set("openingBalance", e.target.value)}
            placeholder="0"
          />
        </div>
      </div>
      {error ? <p className="tiny money-neg">{error}</p> : null}
      <button className="btn btn-primary w-full" onClick={submit} disabled={busy}>
        {busy ? "Saving…" : "Create vendor"}
      </button>
    </div>
  );
}
