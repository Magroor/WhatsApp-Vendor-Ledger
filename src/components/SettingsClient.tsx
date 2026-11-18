"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type SettingsShape = {
  businessName: string;
  currency: string;
  defaultTermDays: number;
  autoReply: boolean;
  autoConfirmThreshold: number;
  reminderCadenceDays: number;
  weeklyReportDay: number;
  whatsappPhoneNumberId: string;
  whatsappBusinessId: string;
  webhookVerifyToken: string;
  timeZone?: string;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ZONES = ["Asia/Karachi", "Asia/Kolkata", "Asia/Dhaka", "Asia/Dubai", "Asia/Riyadh", "Asia/Colombo", "Europe/London", "America/New_York", "UTC"];
const CURRENCIES = ["PKR", "INR", "USD", "AED", "SAR", "BDT", "LKR", "GBP", "EUR"];

export function SettingsForm({
  initial,
  onSaved,
}: {
  initial: SettingsShape;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [form, setForm] = useState<SettingsShape>(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  function set<K extends keyof SettingsShape>(key: K, value: SettingsShape[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      setNote("Saved ✅");
      onSaved?.();
      router.refresh();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <p className="h2">Business profile & automation</p>

      <div>
        <label className="label">Business name (used in WhatsApp replies)</label>
        <input className="field" value={form.businessName} onChange={(e) => set("businessName", e.target.value)} />
      </div>

      <div>
        <label className="label">Time zone (for reports)</label>
        <select className="field" value={form.timeZone ?? "Asia/Karachi"} onChange={(e) => set("timeZone", e.target.value)}>
          {ZONES.map((z) => (
            <option key={z} value={z} className="bg-slate-900">
              {z}
            </option>
          ))}
        </select>
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
          <label className="label">Default terms</label>
          <input
            className="field"
            inputMode="numeric"
            value={form.defaultTermDays}
            onChange={(e) => set("defaultTermDays", Number(e.target.value) || 0)}
          />
        </div>
        <div>
          <label className="label">Auto-post ≥</label>
          <input
            className="field"
            inputMode="numeric"
            value={form.autoConfirmThreshold}
            onChange={(e) => set("autoConfirmThreshold", Number(e.target.value) || 0)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Reminder cadence (days)</label>
          <input
            className="field"
            inputMode="numeric"
            value={form.reminderCadenceDays}
            onChange={(e) => set("reminderCadenceDays", Number(e.target.value) || 1)}
          />
        </div>
        <div>
          <label className="label">Weekly report day</label>
          <select
            className="field"
            value={form.weeklyReportDay}
            onChange={(e) => set("weeklyReportDay", Number(e.target.value))}
          >
            {DAYS.map((d, i) => (
              <option key={d} value={i} className="bg-slate-900">
                {d}
              </option>
            ))}
          </select>
        </div>
      </div>

      <button
        className={`btn w-full ${form.autoReply ? "btn-credit" : ""}`}
        onClick={() => set("autoReply", !form.autoReply)}
      >
        {form.autoReply ? "🤖 Auto-reply bot ON" : "🤖 Auto-reply bot OFF"}
      </button>

      <div>
        <label className="label">WhatsApp Phone Number ID</label>
        <input
          className="field"
          value={form.whatsappPhoneNumberId}
          onChange={(e) => set("whatsappPhoneNumberId", e.target.value)}
          placeholder="1234567890"
        />
      </div>
      <div>
        <label className="label">WhatsApp Business Account ID</label>
        <input
          className="field"
          value={form.whatsappBusinessId}
          onChange={(e) => set("whatsappBusinessId", e.target.value)}
          placeholder="9876543210"
        />
      </div>
      <div>
        <label className="label">Webhook verify token</label>
        <input
          className="field mono"
          value={form.webhookVerifyToken}
          onChange={(e) => set("webhookVerifyToken", e.target.value)}
        />
      </div>

      {note ? <p className="tiny text-indigo-300">{note}</p> : null}
      <button className="btn btn-primary w-full" onClick={save} disabled={busy}>
        {busy ? "Saving…" : "Save settings"}
      </button>
    </div>
  );
}

type TestResult = {
  total: number;
  passed: number;
  failed: number;
  suites: string[];
  failures: Array<{ suite: string; name: string; detail: string }>;
  results: Array<{ suite: string; name: string; pass: boolean; detail: string }>;
};

export function SelfTestPanel() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/selftest");
      setResult((await res.json()) as TestResult);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="h2">Automated test suite</p>
          <p className="tiny muted mt-1">
            Money maths, parser edge cases, FIFO ledger engine, report periods, CSV export,
            signature verification.
          </p>
        </div>
        <button className="btn btn-sm" onClick={run} disabled={busy}>
          {busy ? "Running…" : "▶︎ Run"}
        </button>
      </div>
      {result ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className={`pill ${result.failed === 0 ? "pill-credit" : "pill-debit"}`}>
              {result.failed === 0 ? "ALL PASS" : `${result.failed} FAILED`}
            </span>
            <span className="tiny muted">
              {result.passed}/{result.total} across {result.suites.length} suites
            </span>
          </div>
          {result.suites.map((suite) => {
            const rows = result.results.filter((r) => r.suite === suite);
            const failed = rows.filter((r) => !r.pass).length;
            return (
              <details key={suite} className="rounded-xl border border-white/10 bg-white/5 p-2">
                <summary className="tiny">
                  {failed === 0 ? "✅" : "❌"} {suite} · {rows.length} checks
                </summary>
                <div className="mt-2 space-y-1">
                  {rows.map((r) => (
                    <p key={r.name} className={`tiny ${r.pass ? "muted" : "money-neg"}`}>
                      {r.pass ? "✓" : "✕"} {r.name} — {r.detail}
                    </p>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function SeedButton({ hasData }: { hasData: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function seed(force: boolean) {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const json = await res.json();
      setNote(
        json.seeded
          ? `Seeded ${json.vendors} vendors · ${json.transactions} entries`
          : "Existing data found — use Replace to reseed",
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-2">
      <p className="h2">Demo data</p>
      <p className="tiny muted">
        Loads five realistic vendors with a year of WhatsApp bills and payments so reports,
        aging and reminders have something to show.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <button className="btn btn-sm btn-primary" onClick={() => seed(false)} disabled={busy}>
          {busy ? "Working…" : hasData ? "Fill gaps" : "Seed demo data"}
        </button>
        <button className="btn btn-sm btn-debit" onClick={() => seed(true)} disabled={busy}>
          Replace everything
        </button>
      </div>
      {note ? <p className="tiny muted">{note}</p> : null}
    </div>
  );
}

export function TestWebhookButton({ payload }: { payload: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function fire() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/webhook/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      const json = await res.json();
      setNote(res.ok ? `Webhook accepted · ${json.received ?? 0} message(s)` : `Rejected: ${json.error}`);
      router.refresh();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button className="btn btn-sm btn-primary w-full" onClick={fire} disabled={busy}>
        {busy ? "Sending…" : "🚀 Send test webhook payload"}
      </button>
      {note ? <p className="tiny muted">{note}</p> : null}
    </div>
  );
}
