"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Result = { scanned: number; processed: number; failed: number };

export function SyncRetryButton({ pending }: { pending: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/sync", { method: "POST", body: "{}" });
      setResult((await res.json()) as Result);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="h2">Background sync</p>
          <p className="tiny muted mt-1">
            {pending > 0
              ? `${pending} queued action(s) waiting to retry`
              : "Nothing queued — pipeline is clean"}
          </p>
        </div>
        <button className="btn btn-sm" onClick={run} disabled={busy}>
          {busy ? "Syncing…" : "Run sync"}
        </button>
      </div>
      {result ? (
        <p className="tiny muted mt-2">
          Scanned {result.scanned} · processed {result.processed} · failed {result.failed}
        </p>
      ) : null}
    </div>
  );
}
