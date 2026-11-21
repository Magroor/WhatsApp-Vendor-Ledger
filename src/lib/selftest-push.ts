import type { PayPlan, PayPlanVendor } from "./planner";
import {
  MAX_PAYLOAD_BYTES,
  buildDuePayload,
  buildReviewPayload,
  buildWeeklyPayload,
  classifyPushStatus,
  encodePayload,
  isValidPushEndpoint,
  normalizePrefs,
  parseSubscription,
  wantsKind,
} from "./push";
import type { TestResult } from "./selftest";

function vendor(p: Partial<PayPlanVendor> & { vendorName: string }): PayPlanVendor {
  return {
    vendorId: 1,
    currency: "PKR",
    overdueMinor: 0,
    dueSoonMinor: 0,
    laterMinor: 0,
    dueNowMinor: 0,
    earliestDue: null,
    daysOverdue: 0,
    dueInDays: null,
    label: "",
    ...p,
  };
}

function plan(vendors: PayPlanVendor[]): PayPlan {
  return { currency: "PKR", neededThisWeekMinor: 0, overdueMinor: 0, laterMinor: 0, vendors };
}

// 65-byte P-256 public key / 16-byte auth secret, base64url (shape only, not a real device).
const P256DH = Buffer.alloc(65, 4).toString("base64url");
const AUTH = Buffer.alloc(16, 7).toString("base64url");

/** Pure checks of lib/push (no database, no network). */
export function runPushSelfTests(): TestResult[] {
  const results: TestResult[] = [];
  const check = (name: string, pass: boolean, detail: string) => results.push({ suite: "push", name, pass, detail });

  const one = buildReviewPayload(1);
  const many = buildReviewPayload(3);
  check("review wording singular", one.title === "1 bill to check" && one.body.startsWith("1 bill is"), one.title);
  check("review wording plural", many.title === "3 bills to check" && many.body.startsWith("3 bills are"), many.title);

  const huge = encodePayload({ title: "T", body: "ب".repeat(5000) + '"\\'.repeat(500), url: "/review", tag: "review" });
  const parsed = JSON.parse(huge) as { body: string; url: string };
  check(
    "payload capped in bytes, still valid JSON",
    Buffer.byteLength(huge, "utf8") <= MAX_PAYLOAD_BYTES && parsed.body.endsWith("…") && parsed.url === "/review",
    `${Buffer.byteLength(huge, "utf8")} bytes`,
  );
  const evilUrl = JSON.parse(encodePayload({ title: "x", body: "y", url: "https://evil.example/", tag: "t" })) as { url: string };
  check("payload url forced to same-origin path", evilUrl.url === "/", evilUrl.url);

  check("no due push when nothing is due soon", buildDuePayload(plan([vendor({ vendorName: "A", dueInDays: 5, dueNowMinor: 100 })])) === null, "due in 5 days");
  const due = buildDuePayload(
    plan([
      vendor({ vendorName: "Ali Traders", daysOverdue: 3, dueNowMinor: 150_000 }),
      vendor({ vendorId: 2, vendorName: "Bilal", dueInDays: 1, dueNowMinor: 50_000 }),
      vendor({ vendorId: 3, vendorName: "Later Co", dueInDays: 6, dueNowMinor: 999_900 }),
    ]),
  );
  check(
    "due digest: count + total, skips >2 days",
    due !== null && due.title === "1 payment overdue" && due.body.startsWith("2 vendors") && due.body.includes("2,000") && !due.body.includes("Later Co"),
    due?.body ?? "null",
  );

  const weekly = buildWeeklyPayload({ currency: "PKR", creditMinor: 1_000_000, debitMinor: 250_000, creditCount: 1, debitCount: 2 });
  check("weekly wording", weekly.body.includes("(1 bill)") && weekly.body.includes("(2 payments)") && weekly.tag === "weekly", weekly.body);

  check(
    "prefs filtering",
    wantsKind({ reviewNeeded: true, dueSoon: false, weekly: true }, "weekly") &&
      !wantsKind({ reviewNeeded: true, dueSoon: false, weekly: true }, "dueSoon") &&
      wantsKind(null, "reviewNeeded") &&
      !wantsKind({}, "weekly") &&
      wantsKind("junk", "dueSoon"),
    "explicit, default and junk prefs",
  );
  const merged = normalizePrefs({ weekly: true, extra: 1 }, { reviewNeeded: false, dueSoon: true, weekly: false });
  check(
    "prefs merge keeps stored values, rejects non-booleans",
    merged?.reviewNeeded === false && merged.weekly === true && !("extra" in merged) && normalizePrefs({ weekly: "yes" }) === null && normalizePrefs([]) === null,
    JSON.stringify(merged),
  );

  check(
    "endpoint: real push services accepted",
    isValidPushEndpoint("https://web.push.apple.com/QAbc-123") &&
      isValidPushEndpoint("https://fcm.googleapis.com/fcm/send/abc:def") &&
      isValidPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x") &&
      isValidPushEndpoint("https://wns2-bl2p.notify.windows.com/w/?token=x"),
    "apple, fcm, mozilla, wns",
  );
  const bad = [
    "http://web.push.apple.com/x",
    "https://127.0.0.1/x",
    "https://localhost/x",
    "https://[::1]/x",
    "https://2130706433/x",
    "https://0x7f.0.0.1/x",
    "https://metadata/x",
    "https://printer.local/x",
    "https://user:pw@web.push.apple.com/x",
    "https://web.push.apple.com:8443/x",
    "javascript:alert(1)",
    "https://fcm.googleapis.com/" + "a".repeat(1100),
  ];
  const accepted = bad.filter((u) => isValidPushEndpoint(u));
  check("endpoint: http, IPs, local names, ports, credentials rejected", accepted.length === 0, accepted.join(" ") || `${bad.length} rejected`);

  const good = parseSubscription({ endpoint: "https://web.push.apple.com/QAbc", keys: { p256dh: P256DH, auth: AUTH } });
  check(
    "subscription keys: base64url with the right lengths",
    good !== null &&
      parseSubscription({ endpoint: "https://web.push.apple.com/QAbc", keys: { p256dh: P256DH, auth: "short" } }) === null &&
      parseSubscription({ endpoint: "https://web.push.apple.com/QAbc", keys: { p256dh: "not base64!", auth: AUTH } }) === null &&
      parseSubscription({ endpoint: "https://web.push.apple.com/QAbc" }) === null,
    good ? "valid accepted, invalid rejected" : "valid rejected",
  );

  check(
    "404/410 delete the subscription, 5xx does not",
    classifyPushStatus(410) === "gone" && classifyPushStatus(404) === "gone" && classifyPushStatus(500) === "error" && classifyPushStatus(201) === "ok" && classifyPushStatus(null) === "error",
    "status classification",
  );

  return results;
}
