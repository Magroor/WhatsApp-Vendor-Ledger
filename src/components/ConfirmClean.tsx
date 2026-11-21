"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** One tap to confirm every entry that looks clean (the list is shown first so nothing is a surprise). */
export default function ConfirmClean({ items }: { items: Array<{ id: number; label: string }> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/review/confirm-clean", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not confirm");
      setDone(json.confirmed);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) {
    return (
      <div className="card text-center" role="status">
        <p className="text-2xl">✅</p>
        <p className="h2">{done} entries confirmed</p>
      </div>
    );
  }

  return (
    <div className="card space-y-3 border-emerald-400/30 bg-emerald-500/10">
      <div>
        <p className="h2">✅ {items.length} look clean</p>
        <p className="tiny muted">Vendor known, bill or paid stated, amounts add up. Check the list, then confirm them all.</p>
      </div>
      <ul className="space-y-1 text-sm">
        {items.slice(0, 8).map((i) => (
          <li key={i.id} className="rounded-lg bg-white/5 px-3 py-2">
            {i.label}
          </li>
        ))}
        {items.length > 8 ? <li className="tiny muted">…and {items.length - 8} more</li> : null}
      </ul>
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
      <button className="btn btn-primary w-full" onClick={run} disabled={busy}>
        {busy ? "Confirming…" : `Confirm all ${items.length}`}
      </button>
    </div>
  );
}
