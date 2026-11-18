import crypto from "node:crypto";
import { parseLedgerText, type ParsedDraft } from "./parse";

/**
 * Parser for WhatsApp "Export chat" (.txt) files. Handles both layouts:
 *   iOS:     [12/02/2026, 10:15:32 AM] Ahmed: text
 *   Android: 12/02/2026, 10:15 - Ahmed: text
 * Multi-line messages are joined. Pure (no IO) so it is unit-testable.
 */

export type ChatLine = {
  at: Date;
  sender: string;
  text: string;
  hash: string;
};

export type ChatEntry = ChatLine & { draft: ParsedDraft; postable: boolean };

const HEAD_IOS =
  /^‎?\[(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([APap][Mm])?\]\s+([^:]+?):\s?(.*)$/;
const HEAD_ANDROID =
  /^‎?(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([APap][Mm])?\s+-\s+([^:]+?):\s?(.*)$/;

const MEDIA_ONLY = /^(?:<attached:.*>|<media omitted>|image omitted|.* \(file attached\))$/i;

export function detectDayFirst(text: string): boolean {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const line of text.split("\n").slice(0, 400)) {
    const m = line.match(HEAD_IOS) ?? line.match(HEAD_ANDROID);
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst += 1;
    if (Number(m[2]) > 12) monthFirst += 1;
  }
  return monthFirst <= dayFirst; // default to day-first when unclear
}

export function parseChatExport(
  text: string,
  opts: { dayFirst?: boolean } = {},
): ChatLine[] {
  const dayFirst = opts.dayFirst ?? detectDayFirst(text);
  const out: ChatLine[] = [];
  let current: Omit<ChatLine, "hash"> | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.text.trim();
    if (body && !MEDIA_ONLY.test(body)) {
      const hash = crypto
        .createHash("sha1")
        .update(`${current.at.toISOString()}|${current.sender}|${body}`)
        .digest("hex")
        .slice(0, 24);
      out.push({ ...current, text: body, hash });
    }
    current = null;
  };

  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    const line = rawLine.replace(/[‎‏]/g, "");
    const m = line.match(HEAD_IOS) ?? line.match(HEAD_ANDROID);
    if (!m) {
      if (current) current.text += `\n${line}`;
      continue;
    }
    flush();
    const a = Number(m[1]);
    const b = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const day = dayFirst ? a : b;
    const month = dayFirst ? b : a;
    let hour = Number(m[4]);
    const ampm = m[6]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const at = new Date(year, month - 1, day, hour, Number(m[5]), 0);
    if (Number.isNaN(at.getTime())) continue;
    current = { at, sender: m[7].trim(), text: m[8] ?? "" };
  }
  flush();
  return out;
}

export function draftsFromChat(
  lines: ChatLine[],
  opts: { currency: string; defaultTermDays: number },
): ChatEntry[] {
  return lines.map((l) => {
    const draft = parseLedgerText(l.text, {
      currency: opts.currency,
      now: l.at,
      defaultTermDays: opts.defaultTermDays,
      senderName: l.sender,
    });
    return { ...l, draft, postable: Boolean(draft.entryType && draft.amountMinor) };
  });
}
