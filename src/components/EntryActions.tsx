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

  async function patch(next: "confirmed" | "draft" | "void") {
    setBusy(true);
    try {
      await fetch(`/api/transactions?id=${transactionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await fetch(`/api/transactions?id=${transactionId}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2">
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
      <button className="btn btn-sm btn-debit" onClick={remove} disabled={busy}>
        🗑 Delete
      </button>
    </div>
  );
}
