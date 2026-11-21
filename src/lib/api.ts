import { NextResponse } from "next/server";
import { toMinor } from "./money";

export function ok<T>(data: T, init?: number) {
  return NextResponse.json(data, { status: init ?? 200 });
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

/**
 * Like readJson, but bounded and strict: returns null for a body over
 * `maxBytes`, invalid JSON, or a non-object root (callers answer 400/413).
 */
export async function readJsonObject<T = Record<string, unknown>>(
  req: Request,
  maxBytes = 256 * 1024,
): Promise<{ ok: true; body: T } | { ok: false; status: 400 | 413; error: string }> {
  const declared = Number.parseInt(req.headers.get("content-length") ?? "0", 10);
  if (declared > maxBytes) return { ok: false, status: 413, error: "request body too large" };
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, status: 400, error: "could not read request body" };
  }
  if (raw.length > maxBytes) return { ok: false, status: 413, error: "request body too large" };
  if (!raw.trim()) return { ok: true, body: {} as T };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: "body must be a JSON object" };
    }
    return { ok: true, body: parsed as T };
  } catch {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }
}

/** Largest single ledger amount accepted from a person (100 billion major units). */
export const MAX_AMOUNT_MINOR = 10_000_000_000_000;

/**
 * Strict positive money input for ledger entries: a finite number or a plain
 * amount string ("1,234.50", "Rs 1500", "2k", "1.5 lakh") with at most two
 * decimals. Rejects negatives, zero, junk like "12abc" and absurd values.
 */
export function parsePositiveAmount(
  value: unknown,
): { ok: true; minor: number } | { ok: false; error: string } {
  let minor: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, error: "amount must be a number" };
    if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
      return { ok: false, error: "amount can have at most 2 decimals" };
    }
    minor = Math.round(value * 100);
  } else if (typeof value === "string" && value.trim()) {
    const body = value
      .trim()
      .replace(/[,\s₹$]/g, "")
      .replace(/^(?:rs\.?|pkr|inr|usd|aed|sar|rupees)/i, "")
      .replace(/(?:\/-|rs\.?|pkr|inr|rupees)$/i, "");
    const m = /^(\d+(?:\.(\d+))?|\.(\d+))(k|thousand|lakhs?|lacs?|crores?|cr)?$/i.exec(body);
    if (!m) return { ok: false, error: "amount must be a positive number like 1500 or 1,234.50" };
    const decimals = (m[2] ?? m[3] ?? "").length;
    if (!m[4] && decimals > 2) return { ok: false, error: "amount can have at most 2 decimals" };
    minor = toMinor(value);
  } else {
    return { ok: false, error: "amount required" };
  }
  if (!Number.isFinite(minor) || minor <= 0) return { ok: false, error: "amount must be greater than 0" };
  if (minor > MAX_AMOUNT_MINOR) return { ok: false, error: "amount is too large" };
  return { ok: true, minor };
}

/** Optional free-text field: string/number only, trimmed, capped. */
export function cleanText(value: unknown, max = 1000): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

export function parseAmountToMinor(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value === "string" && value.trim().length) {
    const minor = toMinor(value);
    return minor > 0 ? minor : null;
  }
  return null;
}

export function parseId(value: string | undefined | null): number | null {
  if (!value) return null;
  // Whole positive int4 only: "1e3", "12abc", "1.5" and > 2^31-1 are not ids.
  const s = String(value).trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  const id = Number(s);
  return id > 0 && id <= 2_147_483_647 ? id : null;
}

export function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseDateString(value: unknown): string | null {
  const d = parseDate(value);
  return d ? d.toISOString().slice(0, 10) : null;
}

const buckets = new Map<string, { count: number; resetAt: number }>();

/** Small in-memory guard so a runaway webhook cannot flood the ledger. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

export function clientKey(req: Request, suffix: string): string {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "local";
  return `${suffix}:${ip}`;
}
