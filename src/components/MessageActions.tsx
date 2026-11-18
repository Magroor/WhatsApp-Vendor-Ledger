"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function MessageActions({
  messageId,
  parseStatus,
  hasTransaction,
}: {
  messageId: number;
  parseStatus: string;
  hasTransaction: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [manualAmount, setManualAmount] = useState("");
  const [manualType, setManualType] = useState<"credit" | "debit">("credit");
  const [note, setNote] = useState<string | null>(null);

  async function call(action: "reparse" | "ignore", extra: Record<string, unknown> = {}) {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/messages?id=${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Action failed");
      setNote(
        action === "ignore"
          ? "Marked as ignored"
          : json.posted === false
            ? `Still needs review (${json.reason === "missing-entry-type" ? "credit/debit unclear" : "amount not found"}) — post it manually`
            : json.transactionId
              ? `Entry #${json.transactionId} saved (confidence ${json.draft?.confidence ?? 0}%)`
              : "Still needs review",
      );
      router.refresh();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-sm" onClick={() => call("reparse")} disabled={busy}>
          ♻︎ Re-parse
        </button>
        <button className="btn btn-sm" onClick={() => call("ignore")} disabled={busy}>
          👁 Ignore
        </button>
      </div>

      {!hasTransaction ? (
        <details className="rounded-xl border border-white/10 bg-white/5 p-2">
          <summary className="tiny muted">Post manually</summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <select
              className="field"
              value={manualType}
              onChange={(e) => setManualType(e.target.value as "credit" | "debit")}
            >
              <option value="credit" className="bg-slate-900">credit</option>
              <option value="debit" className="bg-slate-900">debit</option>
            </select>
            <input
              className="field"
              inputMode="decimal"
              placeholder="Amount"
              value={manualAmount}
              onChange={(e) => setManualAmount(e.target.value)}
            />
          </div>
          <button
            className="btn btn-sm btn-primary mt-2 w-full"
            disabled={busy || !manualAmount.trim()}
            onClick={() =>
              call("reparse", {
                entryType: manualType,
                amount: manualAmount.trim(),
              })
            }
          >
            Post to ledger
          </button>
        </details>
      ) : null}

      {parseStatus === "review" && !hasTransaction ? (
        <p className="tiny muted">Needs review — add the amount or direction above.</p>
      ) : null}
      {note ? <p className="tiny text-indigo-300">{note}</p> : null}
    </div>
  );
}
