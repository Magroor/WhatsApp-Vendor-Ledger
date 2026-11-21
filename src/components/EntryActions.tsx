"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function EntryActions({
  transactionId,
  status,
}: {
  transactionId: number;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(url: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "That did not work. Please try again.");
      }
      setConfirmDelete(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const patch = (next: "confirmed" | "draft" | "void") =>
    send(`/api/transactions?id=${transactionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {status === "draft" ? (
          <button className="btn btn-sm btn-credit" onClick={() => patch("confirmed")} disabled={busy}>
            ✅ Confirm
          </button>
        ) : null}
        {status !== "void" ? (
          <button className="btn btn-sm" onClick={() => patch("void")} disabled={busy}>
            ⛔ Void
          </button>
        ) : null}
        {!confirmDelete ? (
          <button className="btn btn-sm btn-debit ml-auto" onClick={() => setConfirmDelete(true)} disabled={busy}>
            🗑 Delete
          </button>
        ) : null}
      </div>

      {confirmDelete ? (
        <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 p-3" role="alertdialog" aria-label="Confirm delete">
          <p className="text-sm">
            Delete this entry for good? This cannot be undone. <b>Void</b> keeps a record and is usually better.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button className="btn btn-sm" onClick={() => setConfirmDelete(false)} disabled={busy} autoFocus>
              Keep it
            </button>
            <button
              className="btn btn-sm btn-debit"
              onClick={() => send(`/api/transactions?id=${transactionId}`, { method: "DELETE" })}
              disabled={busy}
            >
              {busy ? "Deleting…" : "Yes, delete"}
            </button>
          </div>
        </div>
      ) : null}
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
    </div>
  );
}
