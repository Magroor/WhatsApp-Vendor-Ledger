"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

const CURRENCIES = ["PKR", "INR", "USD", "AED", "SAR", "BDT", "LKR", "GBP", "EUR"];

type Form = {
  name: string;
  phone: string;
  businessType: string;
  city: string;
  currency: string;
  creditTermsDays: number;
  openingBalance: string;
};
type Errors = Partial<Record<"name" | "phone" | "openingBalance", string>>;

const EMPTY: Form = {
  name: "",
  phone: "",
  businessType: "",
  city: "",
  currency: "PKR",
  creditTermsDays: 30,
  openingBalance: "",
};

function validate(f: Form): Errors {
  const errors: Errors = {};
  if (f.name.trim().length < 2) errors.name = "Enter the vendor or shop name.";
  if (f.name.trim().length > 80) errors.name = "Name is too long (80 letters at most).";
  const phone = f.phone.trim();
  if (phone) {
    const digits = phone.replace(/[\s()+-]/g, "");
    if (!/^\d{9,15}$/.test(digits)) errors.phone = "Use digits only with country code, e.g. 923211234501.";
  }
  const opening = f.openingBalance.trim().replace(/,/g, "");
  if (opening && !/^-?\d+(\.\d{1,2})?$/.test(opening)) errors.openingBalance = "Enter a number like 5000 or 1250.50.";
  return errors;
}

export default function VendorForm({ open = false }: { open?: boolean }) {
  const router = useRouter();
  const uid = useId();
  const [expanded, setExpanded] = useState(open);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [form, setForm] = useState<Form>(EMPTY);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function submit() {
    setError(null);
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const res = await fetch("/api/vendors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          name: form.name.trim(),
          phone: form.phone.replace(/[\s()+-]/g, ""),
          openingBalance: form.openingBalance.trim().replace(/,/g, ""),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save vendor");
      setForm(EMPTY);
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

  const id = (n: string) => `${uid}-${n}`;
  const bad = (k: keyof Errors) => (errors[k] ? { "aria-invalid": true, "aria-describedby": id(`${k}-err`) } : {});

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <p className="h2">New vendor khata</p>
        <button className="btn btn-sm" onClick={() => setExpanded(false)}>
          Cancel
        </button>
      </div>
      <div>
        <label className="label" htmlFor={id("name")}>
          Vendor / shop name
        </label>
        <input
          id={id("name")}
          className="field"
          value={form.name}
          maxLength={80}
          autoComplete="off"
          onChange={(e) => set("name", e.target.value)}
          placeholder="Ahmed Traders"
          {...bad("name")}
        />
        {errors.name ? (
          <p id={id("name-err")} className="tiny money-neg mt-1">
            {errors.name}
          </p>
        ) : null}
      </div>
      <div>
        <label className="label" htmlFor={id("phone")}>
          WhatsApp number (with country code)
        </label>
        <input
          id={id("phone")}
          className="field"
          inputMode="tel"
          autoComplete="off"
          value={form.phone}
          onChange={(e) => set("phone", e.target.value)}
          placeholder="923211234501"
          {...bad("phone")}
        />
        {errors.phone ? (
          <p id={id("phone-err")} className="tiny money-neg mt-1">
            {errors.phone}
          </p>
        ) : (
          <p className="tiny muted mt-1">Used to match this vendor&apos;s WhatsApp messages. Optional.</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor={id("type")}>
            Business type
          </label>
          <input
            id={id("type")}
            className="field"
            value={form.businessType}
            maxLength={60}
            onChange={(e) => set("businessType", e.target.value)}
            placeholder="Hardware"
          />
        </div>
        <div>
          <label className="label" htmlFor={id("city")}>
            City
          </label>
          <input
            id={id("city")}
            className="field"
            value={form.city}
            maxLength={60}
            onChange={(e) => set("city", e.target.value)}
            placeholder="Lahore"
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="label" htmlFor={id("cur")}>
            Currency
          </label>
          <select id={id("cur")} className="field" value={form.currency} onChange={(e) => set("currency", e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c} className="bg-slate-900">
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={id("terms")}>
            Terms (days)
          </label>
          <input
            id={id("terms")}
            className="field"
            inputMode="numeric"
            value={form.creditTermsDays}
            onChange={(e) => set("creditTermsDays", Math.min(365, Number(e.target.value.replace(/\D/g, "")) || 0))}
          />
        </div>
        <div>
          <label className="label" htmlFor={id("open")}>
            Opening
          </label>
          <input
            id={id("open")}
            className="field"
            inputMode="decimal"
            value={form.openingBalance}
            onChange={(e) => set("openingBalance", e.target.value)}
            placeholder="0"
            {...bad("openingBalance")}
          />
        </div>
      </div>
      {errors.openingBalance ? (
        <p id={id("openingBalance-err")} className="tiny money-neg">
          {errors.openingBalance}
        </p>
      ) : (
        <p className="tiny muted">Opening = what you already owe this vendor today (leave 0 if nothing).</p>
      )}
      {error ? (
        <p className="tiny money-neg" role="alert">
          {error}
        </p>
      ) : null}
      <button className="btn btn-primary w-full" onClick={submit} disabled={busy}>
        {busy ? "Saving…" : "Create vendor"}
      </button>
    </div>
  );
}
