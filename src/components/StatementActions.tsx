"use client";

import { useState } from "react";

export default function StatementActions({
  text,
  phone,
  title,
}: {
  text: string;
  phone: string | null;
  title: string;
}) {
  const [note, setNote] = useState<string | null>(null);

  async function share() {
    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        await navigator.share({ title, text });
        return;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
    const digits = (phone ?? "").replace(/\D/g, "");
    const url = `https://wa.me/${digits ? digits : ""}?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setNote("Copied");
    } catch {
      setNote("Copy failed, select the text manually");
    }
    setTimeout(() => setNote(null), 2500);
  }

  return (
    <div className="no-print space-y-2">
      <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-3">
        <button type="button" className="btn btn-primary" onClick={share}>
          Share on WhatsApp
        </button>
        <button type="button" className="btn" onClick={() => window.print()}>
          Print / Save PDF
        </button>
        <button type="button" className="btn" onClick={copy}>
          Copy text
        </button>
      </div>
      <p className="tiny muted" role="status" aria-live="polite">
        {note ?? ""}
      </p>
    </div>
  );
}
