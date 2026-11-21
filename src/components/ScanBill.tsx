"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import QuickResolve from "@/components/QuickResolve";

type VendorOption = { id: number; name: string };
type Mode = "bill" | "chat";

type Result = {
  messageId?: number;
  vendorId?: number | null;
  vendor?: string;
  transactionId?: number | null;
  amountMinor?: number | null;
  assumedDirection?: boolean;
  needsVendor?: boolean;
  status?: string;
};

type Decoded = { src: CanvasImageSource; width: number; height: number; close: () => void };

/** Decode a photo two ways: createImageBitmap (fast, rotation-aware), else an <img> element. */
async function decode(file: File): Promise<Decoded> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { src: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("decode-failed"));
        el.src = url;
      });
      return { src: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }
}

const MAX_UPLOAD = 3_800_000; // hosting request-body limit is ~4.5 MB

/**
 * Get a photo ready for the AI on the phone: straighten it (phones store rotation as metadata),
 * shrink it and re-encode as JPEG. A 4 MB camera photo becomes ~250 KB, so it uploads in a
 * moment on mobile data and the AI reads it faster. Bills keep more detail (handwriting);
 * chat screenshots only need ~1080 px of width.
 */
async function prepare(file: File, mode: Mode): Promise<Blob> {
  if (file.type === "application/pdf") {
    if (file.size > MAX_UPLOAD) throw new Error("This PDF is too large (max 3.8 MB). Take a photo of the bill instead.");
    return file;
  }
  let img: Decoded;
  try {
    img = await decode(file);
  } catch {
    // Could not decode in this browser: only send the original if it is small enough to upload.
    if (file.size <= MAX_UPLOAD) return file;
    throw new Error("Could not read this photo. Please take a new photo or use a screenshot.");
  }
  try {
    const scale =
      mode === "bill" ? Math.min(1, 1600 / Math.max(img.width, img.height)) : Math.min(1, 1080 / img.width, 3000 / img.height);
    if (scale === 1 && file.type === "image/jpeg" && file.size < 350_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      if (file.size <= MAX_UPLOAD) return file;
      throw new Error("Could not prepare this photo. Please try again.");
    }
    ctx.fillStyle = "#fff"; // PNG screenshots with transparency would turn black as JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img.src, 0, 0, canvas.width, canvas.height);
    const encode = (q: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", q));
    let blob = await encode(0.8);
    if (blob && blob.size > MAX_UPLOAD) blob = await encode(0.6);
    if (!blob || blob.size > MAX_UPLOAD) throw new Error("This photo is too large to upload. Use a smaller picture.");
    return blob;
  } finally {
    img.close();
  }
}

export default function ScanBill({ vendors }: { vendors: VendorOption[] }) {
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const mode = useRef<Mode>("bill");
  const lastUpload = useRef<{ blobs: Blob[]; mode: Mode } | null>(null);

  const [vendorId, setVendorId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<"preparing" | "reading" | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [thumb, setThumb] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string; retry?: boolean } | null>(null);
  const [created, setCreated] = useState<number[]>([]);
  const [undone, setUndone] = useState(false);
  const [resolve, setResolve] = useState<{
    messageId: number;
    vendorId: number | null;
    vendorName: string | null;
    amountMinor: number;
    assumed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => {
      clearInterval(t);
      setSeconds(0);
    };
  }, [busy]);

  useEffect(
    () => () => {
      if (thumb) URL.revokeObjectURL(thumb);
    },
    [thumb],
  );

  const choices = vendors.filter((v) => !v.name.startsWith("Unassigned"));

  function reset() {
    setMessage(null);
    setCreated([]);
    setUndone(false);
    setResolve(null);
  }

  function show(json: { summary?: string; results?: Result[]; transactionIds?: number[] }) {
    setMessage({ ok: true, text: json.summary ?? "Done." });
    const results = json.results ?? [];
    const ids = json.transactionIds ?? results.map((r) => r.transactionId).filter((x): x is number => typeof x === "number");
    setCreated(ids);
    const r = results.length === 1 ? results[0] : null;
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
    router.refresh();
  }

  async function send(body: BodyInit, headers?: HeadersInit) {
    setStage("reading");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 75_000);
    try {
      const res = await fetch("/api/capture", { method: "POST", body, headers, signal: ctl.signal });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not add this. Please try again.");
      show(json);
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      setMessage({
        ok: false,
        retry: true,
        text: aborted ? "This is taking too long. Check your internet connection and tap Try again." : (e as Error).message,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function uploadBlobs(blobs: Blob[], m: Mode) {
    const form = new FormData();
    if (vendorId) form.set("vendorId", vendorId);
    if (note.trim()) form.set("text", note.trim());
    if (m === "chat") form.set("kind", "chat");
    blobs.forEach((b, i) => form.append("image", b, b.type === "application/pdf" ? `bill-${i}.pdf` : `bill-${i}.jpg`));
    await send(form);
  }

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    reset();
    setBusy(true);
    setStage("preparing");
    try {
      const picked = Array.from(files).slice(0, mode.current === "chat" ? 1 : 4);
      const blobs: Blob[] = [];
      try {
        for (const f of picked) blobs.push(await prepare(f, mode.current));
      } catch (e) {
        setMessage({ ok: false, text: (e as Error).message });
        return;
      }
      lastUpload.current = { blobs, mode: mode.current };
      if (blobs[0].type.startsWith("image/")) setThumb(URL.createObjectURL(blobs[0]));
      await uploadBlobs(blobs, mode.current);
    } finally {
      setBusy(false);
      setStage(null);
      if (picker.current) picker.current.value = "";
    }
  }

  async function retry() {
    const last = lastUpload.current;
    if (!last) return;
    reset();
    setBusy(true);
    try {
      await uploadBlobs(last.blobs, last.mode);
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  function choose(m: Mode) {
    mode.current = m;
    picker.current?.click();
  }

  async function openPaste() {
    reset();
    setPasteOpen(true);
    try {
      const clip = (await navigator.clipboard.readText()).trim();
      if (clip) setPasteText(clip.slice(0, 6000));
    } catch {
      /* iPhone may ask for permission or block it: the box stays empty to paste into by hand */
    }
  }

  async function submitPaste() {
    const text = [note.trim(), pasteText.trim()].filter(Boolean).join("\n");
    if (!text) return;
    setBusy(true);
    try {
      await send(JSON.stringify({ text, vendorId: vendorId || undefined }), { "Content-Type": "application/json" });
      setPasteOpen(false);
      setPasteText("");
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  async function undo() {
    setBusy(true);
    try {
      const replies = await Promise.all(
        created.map((id) =>
          fetch(`/api/transactions?id=${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "void" }),
          }).then((r) => r.ok, () => false),
        ),
      );
      if (replies.some((ok) => !ok)) {
        setMessage({ ok: false, text: "Could not undo everything. Open the Inbox or the vendor page and void it there." });
        return;
      }
      setUndone(true);
      setResolve(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const tile =
    "flex min-h-[96px] flex-col items-center justify-center gap-1 rounded-2xl border border-white/15 bg-white/5 px-2 py-3 text-center transition active:scale-[0.97] disabled:opacity-50";

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="h2">➕ Add a bill</h2>
        <p className="tiny muted">Pick one. The amount, vendor and credit/paid are filled in for you.</p>
      </div>

      <input
        ref={picker}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => onPick(e.target.files)}
        aria-label="Choose a photo"
      />

      <div className="grid grid-cols-3 gap-2">
        <button className={tile} disabled={busy} onClick={() => choose("bill")}>
          <span className="text-[28px] leading-none">📷</span>
          <span className="text-[13px] font-semibold">Bill photo</span>
          <span className="tiny muted">camera or gallery</span>
        </button>
        <button className={tile} disabled={busy} onClick={() => choose("chat")}>
          <span className="text-[28px] leading-none">📱</span>
          <span className="text-[13px] font-semibold">Chat screenshot</span>
          <span className="tiny muted">many messages</span>
        </button>
        <button className={tile} disabled={busy} onClick={openPaste}>
          <span className="text-[28px] leading-none">📋</span>
          <span className="text-[13px] font-semibold">Paste text</span>
          <span className="tiny muted">copied message</span>
        </button>
      </div>

      <details className="rounded-xl border border-white/10 bg-white/5 p-3">
        <summary className="tap-link cursor-pointer text-sm font-semibold">Options: choose vendor, add a note</summary>
        <div className="mt-2 space-y-2">
          <select className="field" aria-label="Vendor for this bill" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Find the vendor automatically</option>
            {choices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <input
            className="field"
            aria-label="Note"
            placeholder="Optional note, e.g. udhaar / paid"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </details>

      {pasteOpen ? (
        <div className="space-y-2 rounded-2xl border border-indigo-400/30 bg-indigo-500/10 p-3">
          <label className="label" htmlFor="paste-box">
            Message to add
          </label>
          <textarea
            id="paste-box"
            className="field"
            rows={5}
            autoFocus
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste the WhatsApp message here (press and hold, then Paste)"
          />
          <p className="tiny muted">
            {pasteText ? "Check the text, fix anything wrong, then add it." : "In WhatsApp: press and hold the message, tap Copy, then come back."}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button className="btn btn-sm" onClick={() => setPasteOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-sm btn-primary" onClick={submitPaste} disabled={busy || !pasteText.trim()}>
              {busy ? "Adding…" : "Add to ledger"}
            </button>
          </div>
        </div>
      ) : null}

      {busy ? (
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-3" role="status" aria-live="polite">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="The photo being read" className="h-14 w-14 rounded-lg object-cover" />
          ) : (
            <span className="animate-pulse text-2xl">⏳</span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{stage === "preparing" ? "Preparing the photo…" : "Reading…"}</p>
            <p className="tiny muted">
              {stage === "preparing" ? "Making it small and sharp." : seconds < 8 ? "Usually a few seconds." : `${seconds}s: still working, please wait.`}
            </p>
          </div>
        </div>
      ) : null}

      {resolve && !undone ? (
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

      {message && !busy ? (
        <div
          role="status"
          aria-live="polite"
          className={`rounded-2xl p-3 text-sm ${message.ok ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"}`}
        >
          <p>{undone ? "Undone. That entry was voided." : message.text}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {message.retry ? (
              <button className="btn btn-sm" onClick={retry} disabled={busy}>
                ↻ Try again
              </button>
            ) : null}
            {message.ok && created.length > 0 && !undone ? (
              <button className="btn btn-sm" onClick={undo} disabled={busy}>
                ↶ Undo
              </button>
            ) : null}
            {message.ok ? (
              <a className="btn btn-sm" href="/inbox">
                Open Inbox
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
