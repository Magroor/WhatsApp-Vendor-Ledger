"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

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
  const [vendorId, setVendorId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      if (vendorId) form.set("vendorId", vendorId);
      if (note.trim()) form.set("text", note.trim());
      for (const f of Array.from(files).slice(0, 4)) {
        const small = f.type === "application/pdf" ? f : await shrink(f);
        form.append("image", small, f.type === "application/pdf" ? f.name : "bill.jpg");
      }
      const res = await fetch("/api/capture", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      setMessage({ ok: true, text: json.summary });
      setNote("");
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="card space-y-3">
      <div>
        <p className="h2">📷 Scan a bill</p>
        <p className="tiny muted">
          Take a photo or pick a screenshot of a bill. It is read automatically and added to the ledger.
        </p>
      </div>
      <select className="field" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
        <option value="">Vendor: detect automatically</option>
        {vendors.map((v) => (
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
      <button className="btn btn-primary w-full" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? "Reading bill…" : "📷 Take photo / choose picture"}
      </button>
      {message ? (
        <p className={`rounded-xl p-3 text-sm ${message.ok ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"}`}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
