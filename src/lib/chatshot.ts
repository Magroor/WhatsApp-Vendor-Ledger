import crypto from "node:crypto";
import { fetchGeminiRaw, normalizeMime } from "./ingest";

/**
 * Reads a SCREENSHOT OF A WHATSAPP CHAT (several message bubbles) into separate
 * messages, so each one can be parsed like an imported chat line. A normal bill
 * photo is handled by the single-bill path instead.
 */

export type ShotMessage = {
  side: "me" | "them" | "unknown";
  date: string | null; // as printed, e.g. "12 November 2026" / "Today"
  time: string | null; // e.g. "10:15"
  text: string;
};

export type ChatShot = {
  kind: "chat" | "bill" | "other";
  chatTitle: string | null;
  messages: ShotMessage[];
};

const PROMPT = [
  "You read screenshots for a small business ledger. The image is either (a) a screenshot of a WhatsApp chat, or (b) a photo of a paper bill/receipt, or (c) something else.",
  "Return ONLY JSON: {\"kind\":\"chat\"|\"bill\"|\"other\",\"chatTitle\":string|null,\"messages\":[{\"side\":\"me\"|\"them\",\"date\":string|null,\"time\":string|null,\"text\":string}]}.",
  "For a chat: chatTitle is the contact name or phone number shown at the top. List EVERY visible text message in order, top to bottom. side is \"me\" for green/right-aligned bubbles and \"them\" for white/left-aligned. date is the date separator above the message (copy it as printed, e.g. \"12 November 2026\", \"Today\", \"Yesterday\"), time is the small time under the bubble. Copy text EXACTLY, including numbers, Urdu script and Roman Urdu; never translate, round or fix amounts. Skip system notices, reactions and photos without text; for a photo with a caption use the caption.",
  "For a bill or anything that is not a chat, return kind \"bill\" or \"other\" with an empty messages array.",
].join("\n");

export async function readChatScreenshot(base64: string, mime: string): Promise<{ shot: ChatShot | null; error?: string }> {
  const res = await fetchGeminiRaw({
    systemInstruction: { parts: [{ text: PROMPT }] },
    contents: [
      {
        role: "user",
        parts: [{ inline_data: { mime_type: normalizeMime(mime), data: base64 } }, { text: "Extract the messages." }],
      },
    ],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4096, temperature: 0 },
  });
  if (!res.ok) return { shot: null, error: `vision-gemini-${res.status}` };
  try {
    const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    const parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()) as Partial<ChatShot>;
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages
          .map((m) => ({
            side: m?.side === "me" || m?.side === "them" ? m.side : ("unknown" as const),
            date: typeof m?.date === "string" ? m.date : null,
            time: typeof m?.time === "string" ? m.time : null,
            text: typeof m?.text === "string" ? m.text.trim() : "",
          }))
          .filter((m) => m.text.length > 0)
          .slice(0, 80)
      : [];
    const kind = parsed.kind === "chat" || parsed.kind === "bill" ? parsed.kind : "other";
    return { shot: { kind, chatTitle: typeof parsed.chatTitle === "string" ? parsed.chatTitle.trim() || null : null, messages } };
  } catch {
    return { shot: null, error: "vision-unreadable" };
  }
}

/** Stable per-message key: the same bubble in two overlapping screenshots dedupes. */
export function shotMessageHash(vendorId: number, m: ShotMessage): string {
  const norm = m.text.toLowerCase().replace(/\s+/g, " ").trim();
  return crypto.createHash("sha1").update(`${vendorId}|${m.date ?? ""}|${m.time ?? ""}|${norm}`).digest("hex").slice(0, 24);
}

/** "12 November 2026" / "Today" / "Yesterday" + "10:15" -> Date (best effort, else null). */
export function shotDate(m: ShotMessage, now: Date): Date | null {
  const base = new Date(now);
  const d = (m.date ?? "").trim().toLowerCase();
  if (d === "today") {
    /* keep base */
  } else if (d === "yesterday") {
    base.setDate(base.getDate() - 1);
  } else if (d) {
    const parsed = new Date(m.date as string);
    if (Number.isNaN(parsed.getTime())) return null;
    base.setTime(parsed.getTime());
  } else {
    return null;
  }
  const t = (m.time ?? "").match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
  if (t) {
    let h = Number(t[1]);
    const ap = t[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    base.setHours(h, Number(t[2]), 0, 0);
  } else {
    base.setHours(12, 0, 0, 0);
  }
  return base;
}
