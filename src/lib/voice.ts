import { eq } from "drizzle-orm";
import { db } from "@/db";
import { vendors } from "@/db/schema";
import { fetchGeminiRaw, GEMINI_FAST, GEMINI_SMART } from "./ingest";
import { parseLedgerText } from "./parse";
import { UNASSIGNED_VENDOR } from "./vendormatch";

/**
 * Voice entry: a short recording (Urdu, Roman Urdu or English) such as
 * "Ahmed Traders ko paanch hazar ka credit add karo" becomes a ledger command.
 * Nothing is saved here: the app shows the result and the person confirms it.
 */

export type VoiceCommand = {
  transcript: string;
  entryType: "credit" | "debit" | null;
  amountMinor: number | null;
  vendorId: number | null;
  vendorName: string | null;
  candidates: Array<{ id: number; name: string; score: number }>;
  note: string | null;
  usedFallbackParser: boolean;
};

const PROMPT = [
  "You turn a short voice recording from a Pakistani shop owner into a ledger command. The speech may be Urdu, Roman Urdu, Punjabi-accented Urdu or English, often mixed.",
  'Return ONLY JSON: {"transcript":string,"entryType":"credit"|"debit"|null,"amountRupees":number|null,"vendorName":string|null,"note":string|null}.',
  "transcript: exactly what was said (Urdu in Urdu script, English as English). Do not translate.",
  'entryType: "credit" when a bill / udhaar / maal liya / "credit add karo" / "khata mein likho" is recorded (the shop owes the vendor). "debit" when the shop paid the vendor: paid, diye, ada kiye, bhej diye, de diye, wapis, jama karwaye. null if unclear.',
  "amountRupees: a plain number in rupees. Convert spoken numbers: 5k = 5000, paanch hazar = 5000, dhai hazar = 2500, dedh hazar = 1500, sawa lakh = 125000, dedh lakh = 150000, do lakh = 200000, پانچ ہزار = 5000. null if no amount was spoken. Never guess.",
  "vendorName: the vendor or shop name as spoken (e.g. Ahmed Traders, Zafar, بلال سٹیل). null if none.",
  "note: any extra detail (item, bill number, date) or null.",
  "If the audio has no speech, return transcript \"\" and all other fields null.",
].join("\n");

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Rank saved vendors against a spoken name (works for Roman and Urdu script, partial names). */
export function rankVendors(spoken: string, all: Array<{ id: number; name: string }>) {
  const q = norm(spoken);
  if (!q) return [];
  const qTokens = q.split(" ").filter((t) => t.length > 1);
  const scored = all
    .filter((v) => !v.name.startsWith(UNASSIGNED_VENDOR.split(" ")[0]))
    .map((v) => {
      const n = norm(v.name);
      let score = 0;
      if (n === q) score = 100;
      else if (n.includes(q) || q.includes(n)) score = 85;
      else {
        const nTokens = n.split(" ").filter((t) => t.length > 1);
        const hits = qTokens.filter((t) => nTokens.some((x) => x === t || x.startsWith(t) || t.startsWith(x))).length;
        if (hits) score = Math.round((hits / Math.max(qTokens.length, nTokens.length)) * 70) + 15;
      }
      return { id: v.id, name: v.name, score };
    })
    .filter((v) => v.score >= 30)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 4);
}

async function callGemini(wavBase64: string, mime: string, models: string[], budgetMs: number) {
  const res = await fetchGeminiRaw(
    {
      systemInstruction: { parts: [{ text: PROMPT }] },
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: wavBase64 } }, { text: "Extract the ledger command." }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 512, temperature: 0 },
    },
    budgetMs,
    models,
  );
  if (!res.ok) return { error: `voice-gemini-${res.status}` as string, json: null };
  try {
    const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    return { error: null, json: JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()) as Record<string, unknown> };
  } catch {
    return { error: "voice-unreadable", json: null };
  }
}

export async function interpretVoice(wavBase64: string, mime = "audio/wav"): Promise<{ command?: VoiceCommand; error?: string }> {
  if (!process.env.GEMINI_API_KEY) return { error: "Voice needs GEMINI_API_KEY on the server." };

  let out = await callGemini(wavBase64, mime, GEMINI_FAST, 22_000);
  // Fast model unreadable or deaf: one try with the bigger model.
  if (out.error || !out.json || typeof out.json.transcript !== "string" || !out.json.transcript.trim()) {
    const second = await callGemini(wavBase64, mime, GEMINI_SMART, 24_000);
    if (!second.error && second.json) out = second;
  }
  if (out.error && !out.json) return { error: out.error };
  const j = out.json ?? {};
  const transcript = typeof j.transcript === "string" ? j.transcript.trim() : "";
  if (!transcript) return { command: { transcript: "", entryType: null, amountMinor: null, vendorId: null, vendorName: null, candidates: [], note: null, usedFallbackParser: false } };

  let entryType: "credit" | "debit" | null = j.entryType === "credit" || j.entryType === "debit" ? j.entryType : null;
  let amountMinor =
    typeof j.amountRupees === "number" && Number.isFinite(j.amountRupees) && j.amountRupees > 0 && j.amountRupees < 1e9
      ? Math.round(j.amountRupees * 100)
      : null;

  // Second opinion from the app's own Roman Urdu parser fills gaps the model left.
  let usedFallbackParser = false;
  if (entryType === null || amountMinor === null) {
    const parsed = parseLedgerText(transcript, { currency: "PKR" });
    if (entryType === null && parsed.entryType) {
      entryType = parsed.entryType;
      usedFallbackParser = true;
    }
    if (amountMinor === null && parsed.amountMinor) {
      amountMinor = parsed.amountMinor;
      usedFallbackParser = true;
    }
  }

  const spoken = typeof j.vendorName === "string" ? j.vendorName.trim() : "";
  const all = await db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.archived, false));
  const candidates = rankVendors(spoken || transcript, all);
  const top = candidates[0];
  const clear = top && top.score >= 80 && (!candidates[1] || top.score - candidates[1].score >= 15);

  return {
    command: {
      transcript,
      entryType,
      amountMinor,
      vendorId: clear ? top.id : null,
      vendorName: spoken || null,
      candidates,
      note: typeof j.note === "string" && j.note.trim() ? j.note.trim().slice(0, 200) : null,
      usedFallbackParser,
    },
  };
}
