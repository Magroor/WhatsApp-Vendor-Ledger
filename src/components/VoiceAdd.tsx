"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatMinor } from "@/lib/money";

type Vendor = { id: number; name: string };
type EntryType = "credit" | "debit";
type Heard = {
  transcript: string;
  entryType: EntryType | null;
  amountMinor: number | null;
  vendorId: number | null;
  vendorName: string | null;
  candidates: Array<{ id: number; name: string }>;
  note: string | null;
};

const MAX_SECONDS = 30;

/** Recording -> 16 kHz mono WAV: every phone/browser records differently, WAV is understood everywhere. */
async function toWav(blob: Blob): Promise<Blob> {
  const AC: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF");
    v.setUint32(4, 36 + pcm.length * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i += 1) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  } finally {
    void ctx.close();
  }
}

export default function VoiceAdd({ vendors, onClose }: { vendors: Vendor[]; onClose: () => void }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "recording" | "working" | "confirm" | "saved">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [heard, setHeard] = useState<Heard | null>(null);
  const [type, setType] = useState<EntryType | null>(null);
  const [amountText, setAmountText] = useState("");
  const [vendor, setVendor] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedText, setSavedText] = useState("");
  const [savedId, setSavedId] = useState<number | null>(null);
  const [undone, setUndone] = useState(false);

  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelled = useRef(false);

  const choices = vendors.filter((v) => !v.name.startsWith("Unassigned"));
  const candidateIds = new Set((heard?.candidates ?? []).map((c) => c.id));
  const ordered = [...choices.filter((v) => candidateIds.has(v.id)), ...choices.filter((v) => !candidateIds.has(v.id))];
  const amountNumber = Number(amountText.replace(/,/g, ""));
  const amountOk = Number.isFinite(amountNumber) && amountNumber > 0;

  useEffect(
    () => () => {
      cancelled.current = true;
      if (timer.current) clearInterval(timer.current);
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  async function start() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice recording is not supported on this browser. On iPhone it needs iOS 14.3 or newer, opened in Safari.");
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setError("The microphone is blocked. On iPhone: Settings → Safari → Microphone → Allow, then open KhataLink again.");
      return;
    }
    cancelled.current = false;
    chunks.current = [];
    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported?.(m));
    const r = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined);
    rec.current = r;
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => void finish(r.mimeType);
    r.start();
    setSeconds(0);
    setPhase("recording");
    timer.current = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_SECONDS) stop();
        return s + 1;
      });
    }, 1000);
  }

  function stop() {
    if (timer.current) clearInterval(timer.current);
    if (rec.current && rec.current.state !== "inactive") rec.current.stop();
    stream.current?.getTracks().forEach((t) => t.stop());
  }

  function cancel() {
    cancelled.current = true;
    stop();
    setPhase("idle");
  }

  async function finish(mime: string) {
    if (cancelled.current) return;
    setPhase("working");
    try {
      const raw = new Blob(chunks.current, { type: mime || "audio/mp4" });
      if (raw.size < 1500) throw new Error("I did not hear anything. Tap the microphone, speak, then tap Stop.");
      const wav = await toWav(raw);
      const form = new FormData();
      form.append("audio", wav, "voice.wav");
      const res = await fetch("/api/voice", { method: "POST", body: form });
      const json = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error("You are signed out. Reload KhataLink, sign in, and try again.");
      if (!res.ok) throw new Error(json.error ?? "Could not understand the recording. Please try again.");
      const h = json as Heard;
      if (!h.transcript) throw new Error("I could not hear any words. Speak closer to the phone and try again.");
      setHeard(h);
      setType(h.entryType);
      setAmountText(h.amountMinor ? String(h.amountMinor / 100) : "");
      setVendor(h.vendorId ? String(h.vendorId) : "");
      setPhase("confirm");
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  }

  async function save() {
    if (!type || !amountOk || !vendor || !heard) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorId: Number(vendor),
          entryType: type,
          amount: amountNumber,
          description: heard.note ? `${heard.note} (voice)` : `Voice: ${heard.transcript}`.slice(0, 160),
          status: "confirmed",
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save");
      const name = ordered.find((v) => String(v.id) === vendor)?.name ?? "vendor";
      setSavedText(`${type === "credit" ? "Bill" : "Paid"} ${formatMinor(Math.round(amountNumber * 100), "PKR")} saved to ${name}`);
      setSavedId(json.transaction?.id ?? null);
      setUndone(false);
      setPhase("saved");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!savedId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/transactions?id=${savedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "void" }),
      });
      if (!res.ok) throw new Error("Could not undo. Void it from the vendor page.");
      setUndone(true);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const typeBtn = (t: EntryType, label: string, sub: string, emoji: string, color: string) => (
    <button
      type="button"
      aria-pressed={type === t}
      onClick={() => setType(t)}
      className={`rounded-2xl border p-3 text-left transition-colors ${type === t ? color : "border-white/15 bg-white/5"}`}
    >
      <span className="block text-xl">{emoji}</span>
      <span className="block text-[15px] font-semibold">{label}</span>
      <span className="tiny muted block">{sub}</span>
    </button>
  );

  return (
    <div className="space-y-3 rounded-2xl border border-indigo-400/30 bg-indigo-500/10 p-3" aria-live="polite">
      <div className="flex items-center justify-between">
        <p className="h2">🎤 Say it</p>
        <button className="btn btn-sm" onClick={() => (phase === "recording" ? cancel() : onClose())}>
          Close
        </button>
      </div>

      {phase === "idle" ? (
        <>
          <p className="text-sm">
            Tap the microphone and say the vendor, the amount, and <b>credit</b> (a bill) or <b>paid</b>. Urdu, Roman Urdu or English.
          </p>
          <ul className="tiny muted list-disc space-y-1 pl-5">
            <li>“Ahmed Traders ko paanch hazar ka credit add karo”</li>
            <li>“Zafar Traders ko teen hazar rupay diye”</li>
            <li>“بلال سٹیل کو دس ہزار ادا کیے”</li>
          </ul>
          <button className="btn btn-primary w-full" onClick={start}>
            🎤 Tap to start speaking
          </button>
        </>
      ) : null}

      {phase === "recording" ? (
        <div className="space-y-3 text-center">
          <div className="mx-auto flex h-20 w-20 animate-pulse items-center justify-center rounded-full bg-rose-500/30 text-4xl" aria-hidden="true">
            🎙️
          </div>
          <p className="text-sm font-semibold">
            Listening… {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} <span className="muted">(max {MAX_SECONDS}s)</span>
          </p>
          <button className="btn btn-primary w-full" onClick={stop}>
            ■ Stop and add
          </button>
          <button className="tiny muted underline" onClick={cancel}>
            Cancel
          </button>
        </div>
      ) : null}

      {phase === "working" ? (
        <p className="animate-pulse text-center text-sm font-semibold" role="status">
          Understanding what you said…
        </p>
      ) : null}

      {phase === "confirm" && heard ? (
        <div className="space-y-3">
          <div className="rounded-xl bg-white/5 p-3">
            <p className="tiny muted font-semibold uppercase tracking-wide">I heard</p>
            <p className="mt-1 text-[15px] italic" dir="auto">
              “{heard.transcript}”
            </p>
          </div>

          <div>
            <label className="label" htmlFor="voice-amount">
              Amount (check this carefully)
            </label>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-sm">Rs</span>
              <input
                id="voice-amount"
                className="field w-44 text-lg font-semibold"
                inputMode="decimal"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                placeholder="0"
              />
            </div>
            {!amountText ? <p className="tiny money-neg mt-1">I did not hear an amount. Type it here.</p> : null}
          </div>

          <div>
            <p className="label mb-1">What is this?</p>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Entry type">
              {typeBtn("credit", "Bill", "I owe this (credit)", "🧾", "border-emerald-400 bg-emerald-500/20")}
              {typeBtn("debit", "Paid", "I paid this (debit)", "💸", "border-rose-400 bg-rose-500/20")}
            </div>
          </div>

          <div>
            <label className="label" htmlFor="voice-vendor">
              Which vendor?{heard.vendorName ? ` (you said “${heard.vendorName}”)` : ""}
            </label>
            <select id="voice-vendor" className="field mt-1" value={vendor} onChange={(e) => setVendor(e.target.value)}>
              <option value="">Choose a vendor…</option>
              {ordered.map((v) => (
                <option key={v.id} value={v.id}>
                  {candidateIds.has(v.id) ? "★ " : ""}
                  {v.name}
                </option>
              ))}
            </select>
          </div>

          {error ? <p className="text-sm text-rose-300">{error}</p> : null}
          <button className="btn btn-primary w-full" onClick={save} disabled={busy || !type || !vendor || !amountOk}>
            {busy ? "Saving…" : !type ? "Choose Bill or Paid" : !vendor ? "Choose the vendor" : !amountOk ? "Enter the amount" : "✔ Save to ledger"}
          </button>
          <button
            className="btn btn-sm w-full"
            onClick={() => {
              setHeard(null);
              setError(null);
              setPhase("idle");
            }}
            disabled={busy}
          >
            🎤 Record again
          </button>
        </div>
      ) : null}

      {phase === "saved" ? (
        <div className="space-y-2 rounded-xl bg-emerald-500/15 p-3 text-sm text-emerald-200" role="status">
          <p>{undone ? "Undone. That entry was voided." : `✅ ${savedText}`}</p>
          <div className="flex flex-wrap gap-2">
            {!undone ? (
              <button className="btn btn-sm" onClick={undo} disabled={busy}>
                ↶ Undo
              </button>
            ) : null}
            <button
              className="btn btn-sm"
              onClick={() => {
                setHeard(null);
                setPhase("idle");
              }}
            >
              🎤 Add another
            </button>
          </div>
          {error ? <p className="text-rose-300">{error}</p> : null}
        </div>
      ) : null}

      {phase === "idle" && error ? <p className="text-sm text-rose-300">{error}</p> : null}
    </div>
  );
}
