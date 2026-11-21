import { formatMinor } from "./money";
import type { PayPlan, PayPlanVendor } from "./planner";

/**
 * Web Push (VAPID) for the installed iPhone app.
 *
 * Pure helpers (payload builders, validation, prefs) live at the top and import nothing heavy,
 * so self-tests can load this file without opening the database. The database, the review
 * queue and the web-push library are loaded lazily inside the async functions.
 */

export type PushKind = "reviewNeeded" | "dueSoon" | "weekly";
export const PUSH_KINDS: PushKind[] = ["reviewNeeded", "dueSoon", "weekly"];
export type PushPrefs = Record<PushKind, boolean>;
export const DEFAULT_PUSH_PREFS: PushPrefs = { reviewNeeded: true, dueSoon: true, weekly: false };

export type PushPayload = { title: string; body: string; url: string; tag: string };
export type PushSubscriptionRecord = { endpoint: string; p256dh: string; auth: string };

/** Push services accept ~4 KB; stay well under it after encryption overhead. */
export const MAX_PAYLOAD_BYTES = 2048;
const MAX_TITLE = 80;
const MAX_ENDPOINT = 1024;
const SEND_TIMEOUT_MS = 8000;

/* ------------------------------------------------------------------ config */

function b64urlBytes(value: string): number {
  return Buffer.from(value.replace(/=+$/, ""), "base64url").length;
}

export function vapidConfig(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = (process.env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY ?? "").trim();
  const subject = (process.env.VAPID_SUBJECT ?? "").trim() || "mailto:admin@example.com";
  if (!isBase64Url(publicKey) || !isBase64Url(privateKey)) return null;
  if (b64urlBytes(publicKey) !== 65 || b64urlBytes(privateKey) !== 32) return null;
  return { publicKey, privateKey, subject };
}

export function pushConfigured(): boolean {
  return vapidConfig() !== null;
}

/* --------------------------------------------------------------- validation */

export function isBase64Url(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9_-]+={0,2}$/.test(value);
}

/**
 * The server POSTs to stored endpoints, so only accept public-looking https URLs: default port,
 * no credentials, no IP literals, no localhost / single-label / internal host names.
 * (Structural rules rather than a host allowlist, so a new browser push service still works.)
 */
export function isValidPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_ENDPOINT) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[")) return false; // single label / IPv6 literal
  if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) return false; // IPv4 literal (any form)
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|arpa)$/.test(host)) return false;
  return /^[a-z0-9.-]+$/.test(host);
}

/** Validates a browser PushSubscription JSON ({endpoint, keys:{p256dh, auth}}). */
export function parseSubscription(input: unknown): PushSubscriptionRecord | null {
  if (!input || typeof input !== "object") return null;
  const s = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (!isValidPushEndpoint(s.endpoint)) return null;
  const p256dh = s.keys?.p256dh;
  const auth = s.keys?.auth;
  if (!isBase64Url(p256dh) || !isBase64Url(auth)) return null;
  if (b64urlBytes(p256dh) !== 65 || b64urlBytes(auth) !== 16) return null;
  return { endpoint: s.endpoint, p256dh, auth };
}

/** Keeps only known boolean prefs; missing ones come from `base`. Returns null for junk input. */
export function normalizePrefs(input: unknown, base: PushPrefs = DEFAULT_PUSH_PREFS): PushPrefs | null {
  if (input === undefined || input === null) return { ...base };
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const out: PushPrefs = { ...base };
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!PUSH_KINDS.includes(key as PushKind)) continue;
    if (typeof value !== "boolean") return null;
    out[key as PushKind] = value;
  }
  return out;
}

/** Stored prefs (jsonb, may be partial or junk) -> does this subscription want `kind`? */
export function wantsKind(stored: unknown, kind: PushKind): boolean {
  const prefs = normalizePrefs(stored) ?? DEFAULT_PUSH_PREFS;
  return prefs[kind];
}

/* ----------------------------------------------------------------- payloads */

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function truncateUtf8(s: string, maxBytes: number): string {
  if (utf8Bytes(s) <= maxBytes) return s;
  const chars = Array.from(s);
  while (chars.length && utf8Bytes(chars.join("") + "…") > maxBytes) chars.pop();
  return chars.join("") + "…";
}

/** JSON-encodes a payload, shortening the body (never the JSON) so it fits in `maxBytes`. */
export function encodePayload(p: PushPayload, maxBytes = MAX_PAYLOAD_BYTES): string {
  const safeUrl = typeof p.url === "string" && p.url.startsWith("/") && !p.url.startsWith("//") ? p.url.slice(0, 200) : "/";
  const base = {
    title: truncateUtf8(String(p.title ?? ""), MAX_TITLE * 4).slice(0, MAX_TITLE),
    body: "",
    url: safeUrl,
    tag: String(p.tag ?? "khatalink").slice(0, 40),
  };
  const room = maxBytes - utf8Bytes(JSON.stringify(base));
  // JSON escaping can grow the body (quotes, control chars); shrink until the whole thing fits.
  let budget = Math.max(0, room);
  let body = truncateUtf8(String(p.body ?? ""), budget);
  let json = JSON.stringify({ ...base, body });
  while (utf8Bytes(json) > maxBytes && budget > 0) {
    budget = Math.max(0, budget - Math.max(8, utf8Bytes(json) - maxBytes));
    body = budget ? truncateUtf8(String(p.body ?? ""), budget) : "";
    json = JSON.stringify({ ...base, body });
  }
  return json;
}

export function buildReviewPayload(count: number): PushPayload {
  const n = Math.max(0, Math.floor(count));
  return {
    title: n === 1 ? "1 bill to check" : `${n} bills to check`,
    body: `${plural(n, "bill is", "bills are")} waiting in Needs review. Tap to confirm. (Check kar lein)`,
    url: "/review",
    tag: "review",
  };
}

/** Vendors overdue or due within `withinDays` (inclusive). */
export function dueSoonVendors(plan: PayPlan, withinDays = 2): PayPlanVendor[] {
  return plan.vendors.filter((v) => v.daysOverdue > 0 || (v.dueInDays !== null && v.dueInDays <= withinDays));
}

/** Digest for the daily cron, or null when nothing is overdue / due in the next 2 days. */
export function buildDuePayload(plan: PayPlan, withinDays = 2): PushPayload | null {
  const due = dueSoonVendors(plan, withinDays);
  if (!due.length) return null;
  const currency = due[0].currency || plan.currency;
  const total = due.reduce((a, v) => a + v.dueNowMinor, 0);
  const overdue = due.filter((v) => v.daysOverdue > 0).length;
  const names = due.slice(0, 3).map((v) => v.vendorName).join(", ");
  const more = due.length > 3 ? ` +${due.length - 3} more` : "";
  return {
    title: overdue
      ? `${plural(overdue, "payment")} overdue`
      : `${plural(due.length, "payment")} due soon`,
    body: `${plural(due.length, "vendor")} to pay this week: ${formatMinor(total, currency)} (${names}${more}). Payment ka waqt.`,
    url: "/",
    tag: "due",
  };
}

export type WeeklyPushSummary = {
  currency: string;
  creditMinor: number;
  debitMinor: number;
  creditCount: number;
  debitCount: number;
  /** Overdue + due this week right now (from the pay plan). */
  dueNowMinor?: number;
};

export function buildWeeklyPayload(s: WeeklyPushSummary): PushPayload {
  const parts = [
    `Bills: ${formatMinor(s.creditMinor, s.currency)} (${plural(s.creditCount, "bill")})`,
    `Paid: ${formatMinor(s.debitMinor, s.currency)} (${plural(s.debitCount, "payment")})`,
  ];
  if (s.dueNowMinor && s.dueNowMinor > 0) parts.push(`To pay now: ${formatMinor(s.dueNowMinor, s.currency)}`);
  return {
    title: "Weekly summary",
    body: `Last 7 days. ${parts.join(". ")}.`,
    url: "/reports",
    tag: "weekly",
  };
}

/* -------------------------------------------------------------------- send */

export type SendResult = { ok: boolean; gone: boolean; statusCode: number | null; error?: string };
export type PushSender = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: Record<string, unknown>,
) => Promise<{ statusCode?: number }>;

/** 404/410 = the browser dropped the subscription: delete it. Others may be temporary. */
export function classifyPushStatus(statusCode: number | null | undefined): "ok" | "gone" | "error" {
  if (statusCode === 404 || statusCode === 410) return "gone";
  if (typeof statusCode === "number" && statusCode >= 200 && statusCode < 300) return "ok";
  return "error";
}

async function defaultSender(): Promise<PushSender> {
  const wp = await import("web-push");
  return (sub, payload, options) => wp.sendNotification(sub, payload, options as never);
}

async function deleteSubscription(endpoint: string): Promise<void> {
  const [{ db }, { pushSubscriptions }, { eq }] = await Promise.all([
    import("@/db"),
    import("@/db/schema"),
    import("drizzle-orm"),
  ]);
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("push-timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Sends one notification. Never throws. Deletes the subscription when the push service says
 * it no longer exists (404/410). `deps` lets tests inject a stub sender / remover.
 */
export async function sendPush(
  sub: PushSubscriptionRecord,
  payload: PushPayload,
  deps: { sender?: PushSender; remove?: (endpoint: string) => Promise<void>; vapid?: ReturnType<typeof vapidConfig> } = {},
): Promise<SendResult> {
  try {
    const vapid = deps.vapid === undefined ? vapidConfig() : deps.vapid;
    if (!vapid) return { ok: false, gone: false, statusCode: null, error: "not-configured" };
    if (!isValidPushEndpoint(sub.endpoint)) return { ok: false, gone: false, statusCode: null, error: "bad-endpoint" };
    const sender = deps.sender ?? (await defaultSender());
    const res = await withTimeout(
      sender(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        encodePayload(payload),
        {
          TTL: 60 * 60 * 24,
          urgency: "normal",
          timeout: SEND_TIMEOUT_MS,
          vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        },
      ),
      SEND_TIMEOUT_MS + 1000,
    );
    const statusCode = typeof res?.statusCode === "number" ? res.statusCode : 201;
    return { ok: classifyPushStatus(statusCode) === "ok", gone: false, statusCode };
  } catch (error) {
    const statusCode = (error as { statusCode?: number } | null)?.statusCode ?? null;
    const gone = classifyPushStatus(statusCode) === "gone";
    if (gone) {
      await (deps.remove ?? deleteSubscription)(sub.endpoint).catch(() => undefined);
    }
    return { ok: false, gone, statusCode, error: String((error as Error)?.message ?? error).slice(0, 200) };
  }
}

export type BroadcastResult = { configured: boolean; targeted: number; sent: number; removed: number; failed: number };

/** Sends to every subscription that has `kind` switched on. Never throws. */
export async function sendPushToAll(kind: PushKind, payload: PushPayload): Promise<BroadcastResult> {
  const result: BroadcastResult = { configured: pushConfigured(), targeted: 0, sent: 0, removed: 0, failed: 0 };
  if (!result.configured) return result;
  try {
    const [{ db }, { pushSubscriptions }, { eq }] = await Promise.all([
      import("@/db"),
      import("@/db/schema"),
      import("drizzle-orm"),
    ]);
    const subs = await db.select().from(pushSubscriptions);
    const targets = subs.filter((s) => wantsKind(s.prefs, kind));
    result.targeted = targets.length;
    const outcomes = await Promise.all(targets.map((s) => sendPush(s, payload)));
    const okEndpoints: string[] = [];
    outcomes.forEach((o, i) => {
      if (o.ok) {
        result.sent += 1;
        okEndpoints.push(targets[i].endpoint);
      } else if (o.gone) result.removed += 1;
      else result.failed += 1;
    });
    for (const endpoint of okEndpoints) {
      await db
        .update(pushSubscriptions)
        .set({ lastSeenAt: new Date() })
        .where(eq(pushSubscriptions.endpoint, endpoint))
        .catch(() => undefined);
    }
  } catch (error) {
    console.error("[push] broadcast failed:", (error as Error).message);
  }
  return result;
}

/* -------------------------------------------------------------- triggers */

const REVIEW_THROTTLE_MS = 60_000;
let lastReviewAt = 0;

/**
 * "N bills to check" to everyone with reviewNeeded on. Throttled in-process to one push a minute
 * (capture + ingest + retries and multi-photo uploads all report review items in bursts); the
 * slot is claimed before any await so concurrent calls cannot both send. Never throws.
 */
export async function notifyReviewNeeded(): Promise<BroadcastResult | null> {
  try {
    if (!pushConfigured()) return null;
    const now = Date.now();
    if (now - lastReviewAt < REVIEW_THROTTLE_MS) return null;
    lastReviewAt = now;
    const { getReviewItems } = await import("./review");
    const count = (await getReviewItems(200)).length;
    if (count <= 0) {
      lastReviewAt = 0; // nothing sent: do not block the next real one
      return null;
    }
    return await sendPushToAll("reviewNeeded", buildReviewPayload(count));
  } catch (error) {
    console.error("[push] notifyReviewNeeded failed:", (error as Error).message);
    return null;
  }
}
