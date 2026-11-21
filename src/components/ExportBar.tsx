"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};
function detectFileShare(): boolean {
  try {
    if (typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof File === "undefined") return false;
    const probe = new File(["x"], "probe.csv", { type: "text/csv" });
    return Boolean(navigator.canShare && navigator.canShare({ files: [probe] }));
  } catch {
    return false;
  }
}

export default function ExportBar({
  period,
  anchor,
  vendorId,
  shareText,
  fileName,
  kind,
}: {
  period: string;
  anchor: string;
  vendorId?: number;
  shareText: string;
  fileName?: string;
  /** "customer" scopes CSV / print to customers; omitted = vendors. */
  kind?: "vendor" | "customer";
}) {
  const [note, setNote] = useState<string | null>(null);
  const [csv, setCsv] = useState<{ href: string; file: File } | null>(null);
  const [fetchFailed, setFetchFailed] = useState<string | null>(null);
  const supportsShare = useSyncExternalStore(noopSubscribe, detectFileShare, () => false);

  const query = useMemo(() => {
    const q = new URLSearchParams({ period, anchor });
    if (vendorId) q.set("vendorId", String(vendorId));
    if (kind === "customer") q.set("kind", "customer");
    return q.toString();
  }, [period, anchor, vendorId, kind]);
  const csvHref = `/api/reports/export?${query}`;
  const name = fileName ?? `ledger-${period}.csv`;

  // Prefetch the CSV so the tap handler can call navigator.share() without
  // awaiting a fetch first — iOS Safari drops the user gesture across a slow await.
  useEffect(() => {
    if (!supportsShare) return;
    let cancelled = false;
    fetch(csvHref, { cache: "no-store" })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        if (!cancelled) setCsv({ href: csvHref, file: new File([blob], name, { type: "text/csv" }) });
      })
      .catch(() => {
        if (!cancelled) setFetchFailed(csvHref);
      });
    return () => {
      cancelled = true;
    };
  }, [csvHref, name, supportsShare]);

  const csvFile = csv && csv.href === csvHref ? csv.file : null;
  const canShareFiles = supportsShare && fetchFailed !== csvHref;

  async function shareCsv() {
    if (!csvFile) return;
    try {
      await navigator.share({ files: [csvFile], title: name, text: shareText.split("\n")[0] });
      setNote(null);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      setNote("Sharing not available — use the CSV download instead.");
    }
  }

  async function saveSnapshot() {
    const q = new URLSearchParams(query);
    q.set("save", "1");
    try {
      const res = await fetch(`/api/reports?${q.toString()}`);
      setNote(res.ok ? "Snapshot saved for audit" : "Could not save snapshot");
    } catch {
      setNote("Could not save snapshot (offline?)");
    }
  }

  return (
    <div className="card no-print space-y-2">
      <p className="h2">Export & share</p>
      <div className="grid grid-cols-2 gap-2">
        <a className="btn btn-sm" href={csvHref} download={name}>
          ⬇︎ CSV
        </a>
        {canShareFiles ? (
          <button className="btn btn-sm" onClick={shareCsv} disabled={!csvFile}>
            {csvFile ? "📤 Share CSV" : "Preparing CSV…"}
          </button>
        ) : null}
        <a className="btn btn-sm" href={`/reports/print?${query}`}>
          🖨 PDF / Print
        </a>
        <a
          className="btn btn-sm"
          href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
          target="_blank"
          rel="noreferrer"
        >
          💬 WhatsApp
        </a>
        <button className="btn btn-sm" onClick={saveSnapshot}>
          🔒 Snapshot
        </button>
      </div>
      {note ? <p className="tiny muted">{note}</p> : null}
      <p className="tiny muted">
        On iPhone: open PDF / Print, tap Share ▸ Print, pinch out on the preview, then Share ▸
        Save to Files. Share CSV sends the spreadsheet to WhatsApp, Mail or Files.
      </p>
    </div>
  );
}
