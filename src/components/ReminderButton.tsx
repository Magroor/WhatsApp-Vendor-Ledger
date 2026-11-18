"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Result = {
  delivered: boolean;
  simulated: boolean;
  balanceMinor: number;
  oldestAgeDays: number;
  whatsappLink: string | null;
  reminder?: { messageText: string };
};

export default function ReminderButton({
  vendorId,
  vendorName,
  size = "sm",
}: {
  vendorId: number;
  vendorName: string;
  size?: "sm" | "md";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not queue reminder");
      setResult(json as Result);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        className={`btn btn-sm ${size === "md" ? "btn-debit w-full" : ""}`}
        onClick={send}
        disabled={busy}
      >
        {busy ? "Sending…" : "🔔 Reminder"}
      </button>
      {error ? <p className="tiny money-neg">{error}</p> : null}
      {result ? (
        <div className="max-w-[220px] rounded-lg border border-white/10 bg-white/5 p-2">
          <p className="tiny muted">
            {result.delivered
              ? "Sent via WhatsApp Business API"
              : result.simulated
                ? "Queued — no live WhatsApp credentials on this device"
                : "Failed — stored in retry queue"}
            {" · "}
            {result.oldestAgeDays}d oldest
          </p>
          {result.whatsappLink ? (
            <a
              className="btn btn-sm mt-2 w-full"
              href={result.whatsappLink}
              target="_blank"
              rel="noreferrer"
            >
              💬 Open chat with {vendorName}
            </a>
          ) : null}
          {result.reminder?.messageText ? (
            <details className="mt-2">
              <summary className="tiny muted">Preview message</summary>
              <p className="bubble mt-2">{result.reminder.messageText}</p>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
