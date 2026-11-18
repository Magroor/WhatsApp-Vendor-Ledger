"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * Print / PDF controls. In an iOS home-screen PWA there is no browser chrome
 * and window.close() is a no-op, so we offer: Print (window.print), Share
 * (native share sheet — "Print" / "Save to Files" from there), CSV download
 * and a real link back to the report.
 */
export function PrintButton({
  backHref = "/reports",
  csvHref,
  title = "Ledger report",
}: {
  backHref?: string;
  csvHref?: string;
  title?: string;
}) {
  const canPrint = useSyncExternalStore(noopSubscribe, () => typeof window.print === "function", () => true);
  const canShare = useSyncExternalStore(noopSubscribe, () => typeof navigator.share === "function", () => false);
  const [note, setNote] = useState<string | null>(null);

  function doPrint() {
    try {
      window.print();
    } catch {
      setNote("Printing is not available here — use Share ▸ Print or Save to Files.");
    }
  }

  async function doShare() {
    try {
      await navigator.share({ title, url: window.location.href });
    } catch (err) {
      if ((err as { name?: string })?.name !== "AbortError") setNote("Could not open the share sheet.");
    }
  }

  return (
    <div className="no-print mb-4 space-y-2">
      <div className="flex flex-wrap gap-2">
        {canPrint ? (
          <button className="btn btn-primary" onClick={doPrint}>
            🖨 Print / Save PDF
          </button>
        ) : null}
        {canShare ? (
          <button className="btn" onClick={doShare}>
            📤 Share
          </button>
        ) : null}
        {csvHref ? (
          <a className="btn" href={csvHref} download>
            ⬇︎ CSV
          </a>
        ) : null}
        <Link className="btn" href={backHref}>
          ← Back
        </Link>
      </div>
      {note ? <p className="text-xs text-black/60">{note}</p> : null}
    </div>
  );
}

export default PrintButton;
