"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Counts = { vendors: number; entries: number; messages: number; photos: number };

/** Clears test data safely: shows what will go, asks for the word RESET, keeps Settings. */
export default function ResetData() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [keepVendors, setKeepVendors] = useState(true);
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setOpen(true);
    setDone(null);
    setError(null);
    setWord("");
    try {
      const res = await fetch("/api/reset", { cache: "no-store" });
      if (res.ok) setCounts(await res.json());
    } catch {
      /* the numbers are only a convenience */
    }
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: word, keepVendors }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Reset failed");
      setDone(
        `Cleared ${json.removed.entries} entries, ${json.removed.messages} messages and ${json.removed.photos} photos${
          json.keptVendors ? ". Vendors kept." : ` and ${json.removed.vendors} vendors.`
        }`,
      );
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3 border-rose-400/30">
      <div>
        <p className="h2">Reset test data</p>
        <p className="tiny muted">
          Clears entries, messages, bill photos and reports so you can start clean. Your Settings and the app itself are not
          touched.
        </p>
      </div>

      {done ? <p className="rounded-xl bg-emerald-500/15 p-3 text-sm text-emerald-200">✅ {done}</p> : null}

      {!open ? (
        <button className="btn btn-sm btn-debit w-full" onClick={start}>
          🧹 Reset test data…
        </button>
      ) : (
        <div className="space-y-3">
          {counts ? (
            <p className="rounded-xl bg-white/5 p-3 text-sm">
              This will delete <b>{counts.entries}</b> entries, <b>{counts.messages}</b> messages and <b>{counts.photos}</b> bill
              photos{keepVendors ? "" : <>, and <b>{counts.vendors}</b> vendors</>}.
            </p>
          ) : null}

          <label className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-3">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5"
              checked={keepVendors}
              onChange={(e) => setKeepVendors(e.target.checked)}
            />
            <span className="text-sm">
              <b>Keep my vendors</b>
              <span className="tiny muted block">Untick to delete vendors too (starts completely empty).</span>
            </span>
          </label>

          <div>
            <label className="label" htmlFor="reset-word">
              Type RESET to confirm
            </label>
            <input
              id="reset-word"
              className="field mt-1"
              autoCapitalize="characters"
              autoCorrect="off"
              value={word}
              onChange={(e) => setWord(e.target.value)}
              placeholder="RESET"
            />
          </div>
          <p className="tiny muted">This cannot be undone. Make a backup first if any of it is real.</p>
          {error ? <p className="text-sm text-rose-300">{error}</p> : null}
          <div className="grid grid-cols-2 gap-2">
            <button className="btn btn-sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-sm btn-debit" onClick={run} disabled={busy || word !== "RESET"}>
              {busy ? "Clearing…" : "Clear data"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
