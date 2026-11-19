"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import QuickResolve from "@/components/QuickResolve";

type VendorOption = { id: number; name: string };

/** Shrink the photo on the phone: faster upload, and under hosting body limits. */
async function shrink(file: File, maxSide = 1600, quality = 0.82): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not open this photo."));
      el.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error("Could not prepare the photo.");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function ScanBill({ vendors }: { vendors: VendorOption[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const mode = useRef<"bill" | "chat">("bill");
  const [vendorId, setVendorId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [resolve, setResolve] = useState<{
    messageId: number;
    vendorId: number | null;
    vendorName: string | null;
    amountMinor: number | null;
    assumed: boolean;
  } | null>(null);

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      if (vendorId) form.set("vendorId", vendorId);
      if (note.trim()) form.set("text", note.trim());
      if (mode.current === "chat") form.set("kind", "chat");
      for (const f of Array.from(files).slice(0, mode.current === "chat" ? 1 : 4)) {
        const small = f.type === "application/pdf" ? f : await shrink(f);
        form.append("image", small, f.type === "application/pdf" ? f.name : "bill.jpg");
      }
      const res = await fetch("/api/capture", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      setMessage({ ok: true, text: json.summary });
      // One bill that still needs a decision (bill or payment? which vendor?): ask right here.
      const r = Array.isArray(json.results) && json.results.length === 1 ? json.results[0] : null;
      setResolve(
        r && r.messageId && r.amountMinor && (r.assumedDirection || r.needsVendor || r.status === "review")
          ? {
              messageId: r.messageId,
              vendorId: r.needsVendor ? null : (r.vendorId ?? null),
              vendorName: r.vendor ?? null,
              amountMinor: r.amountMinor,
              assumed: Boolean(r.assumedDirection),
            }
          : null,
      );
      setNote("");
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  /** WhatsApp text has no Share option: copy the message, then tap this. */
  async function pasteAndAdd() {
    setBusy(true);
    setMessage(null);
    try {
      let clip = "";
      try {
        clip = (await navigator.clipboard.readText()).trim();
      } catch {
        throw new Error("Allow “Paste” when iPhone asks, or paste the message in the box below.");
      }
      if (!clip) throw new Error("Nothing copied yet. In WhatsApp, press and hold a message, then tap Copy.");
      const res = await fetch("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: [note.trim(), clip].filter(Boolean).join("\n"), vendorId: vendorId || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not add it");
      setMessage({ ok: true, text: json.summary });
      setNote("");
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <div>
        <p className="h2">➕ Add bills</p>
        <p className="tiny muted">
          Photo of a bill, a screenshot of a WhatsApp chat, or a copied message: it is read automatically and added to the ledger.
        </p>
      </div>
      <select className="field" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
        <option value="">Vendor: detect automatically</option>
        {vendors.filter((v) => !v.name.startsWith("Unassigned")).map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      <input
        className="field"
        placeholder="Optional note, e.g. udhaar / paid"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => onPick(e.target.files)}
      />
      <button
        className="btn btn-primary w-full"
        disabled={busy}
        onClick={() => {
          mode.current = "bill";
          input.current?.click();
        }}
      >
        {busy ? "Reading…" : "📷 Take photo / choose picture"}
      </button>
      <button
        className="btn w-full"
        disabled={busy}
        onClick={() => {
          mode.current = "chat";
          input.current?.click();
        }}
      >
        📱 Add a WhatsApp chat screenshot
      </button>
      <button className="btn w-full" disabled={busy} onClick={pasteAndAdd}>
        📋 Paste copied WhatsApp message
      </button>
      <p className="tiny muted">
        <b>Chat screenshot:</b> take a screenshot of the vendor chat in WhatsApp (side button + volume up), then
        choose it here. Every bill and payment message in it is added; repeats are skipped. For one message:
        press and hold → <b>Copy</b> → Paste.
      </p>
      {resolve ? (
        <QuickResolve
          key={resolve.messageId}
          messageId={resolve.messageId}
          vendors={vendors}
          vendorId={resolve.vendorId}
          vendorName={resolve.vendorName}
          amountMinor={resolve.amountMinor}
          entryType={null}
          assumed={resolve.assumed}
          onSaved={() => setMessage(null)}
        />
      ) : null}
      {message ? (
        <p className={`rounded-xl p-3 text-sm ${message.ok ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"}`}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
