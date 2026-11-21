"use client";

import { useCallback, useEffect, useState } from "react";
import type { PushKind, PushPrefs } from "@/lib/push";

type Phase = "loading" | "unavailable" | "unconfigured" | "dev" | "denied" | "off" | "on";

const TOGGLES: Array<{ kind: PushKind; label: string; hint: string }> = [
  { kind: "reviewNeeded", label: "New bills to review", hint: "When a bill needs your check" },
  { kind: "dueSoon", label: "Payments due", hint: "Overdue or due in the next 2 days" },
  { kind: "weekly", label: "Weekly summary", hint: "On your weekly report day" },
];

const DEFAULT_PREFS: PushPrefs = { reviewNeeded: true, dueSoon: true, weekly: false };

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function postJson(url: string, body: unknown, method = "POST") {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string; prefs?: PushPrefs };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export default function PushSettings() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<PushPrefs>(DEFAULT_PREFS);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    if (!supported) return setPhase("unavailable");
    let key: { configured?: boolean; publicKey?: string | null } = {};
    try {
      key = await (await fetch("/api/push/key", { cache: "no-store" })).json();
    } catch {
      return setPhase("unconfigured");
    }
    if (!key.configured || !key.publicKey) return setPhase("unconfigured");
    setPublicKey(key.publicKey);
    if (process.env.NODE_ENV !== "production") return setPhase("dev");

    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      setEndpoint(sub.endpoint);
      try {
        const res = await fetch(`/api/push/prefs?endpoint=${encodeURIComponent(sub.endpoint)}`, { cache: "no-store" });
        if (res.ok) {
          setPrefs(((await res.json()) as { prefs: PushPrefs }).prefs);
        } else if (res.status === 404) {
          // The server forgot this device (e.g. database reset): save it again.
          const saved = await postJson("/api/push/subscribe", { subscription: sub.toJSON() });
          if (saved.prefs) setPrefs(saved.prefs);
        }
      } catch {
        /* show "On" with default toggles */
      }
      return setPhase("on");
    }
    setPhase(Notification.permission === "denied" ? "denied" : "off");
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-off feature detection after mount
    void refresh();
  }, [refresh]);

  async function enable() {
    setMsg(null);
    // Ask first, straight from the tap: iOS ignores the request once anything else was awaited.
    let permission: NotificationPermission;
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = "denied";
    }
    if (permission !== "granted") {
      setPhase(permission === "denied" ? "denied" : "off");
      return;
    }
    if (!publicKey) return setMsg("Server key missing. Reload the page.");
    setBusy(true);
    try {
      const reg = (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/sw.js"));
      const ready = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((r) => setTimeout(() => r(null), 8000)),
      ]);
      const active = ready ?? reg;
      const sub =
        (await active.pushManager.getSubscription()) ??
        (await active.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) }));
      const saved = await postJson("/api/push/subscribe", { subscription: sub.toJSON(), prefs });
      setEndpoint(sub.endpoint);
      if (saved.prefs) setPrefs(saved.prefs);
      setPhase("on");
      setMsg("Notifications are on for this device.");
    } catch (e) {
      setMsg(`Could not turn on notifications: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(kind: PushKind) {
    if (!endpoint) return;
    const next = { ...prefs, [kind]: !prefs[kind] };
    setPrefs(next);
    try {
      const saved = await postJson("/api/push/prefs", { endpoint, prefs: { [kind]: next[kind] } }, "PATCH");
      if (saved.prefs) setPrefs(saved.prefs);
    } catch (e) {
      setPrefs(prefs);
      setMsg((e as Error).message);
    }
  }

  async function sendTest() {
    if (!endpoint) return;
    setBusy(true);
    setMsg(null);
    try {
      await postJson("/api/push/test", { endpoint });
      setMsg("Test sent. It should arrive in a few seconds.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setMsg(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      const ep = sub?.endpoint ?? endpoint;
      if (sub) await sub.unsubscribe().catch(() => false);
      if (ep) await postJson("/api/push/unsubscribe", { endpoint: ep }).catch(() => undefined);
      setEndpoint(null);
      setPhase("off");
      setMsg("Notifications are off for this device.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="h2">Notifications</h2>
        <p className="tiny muted mt-0.5">Bills to review, payments due, weekly summary</p>
      </div>

      {phase === "loading" ? <p className="tiny muted">Checking this device…</p> : null}

      {phase === "unavailable" ? (
        <div className="space-y-1">
          <p className="text-sm font-semibold">Not available on this browser</p>
          <p className="tiny muted">
            {typeof navigator !== "undefined" && isIos() && !isStandalone()
              ? "On iPhone, notifications only work in the installed app: Safari ▸ Share ▸ Add to Home Screen, then open KhataLink from the Home Screen (iOS 16.4 or newer)."
              : "This browser cannot receive web notifications. On iPhone, add the app to the Home Screen first (iOS 16.4 or newer)."}
          </p>
        </div>
      ) : null}

      {phase === "unconfigured" ? (
        <div className="space-y-1">
          <p className="text-sm font-semibold">Not configured on the server</p>
          <p className="tiny muted">
            Admin: set <span className="mono">VAPID_PUBLIC_KEY</span> and <span className="mono">VAPID_PRIVATE_KEY</span> (make them with{" "}
            <span className="mono">npx web-push generate-vapid-keys</span>) and redeploy.
          </p>
        </div>
      ) : null}

      {phase === "dev" ? (
        <p className="tiny muted">
          Development mode: the service worker is switched off here, so notifications cannot be turned on. Open the installed app
          (production) to use them.
        </p>
      ) : null}

      {phase === "denied" ? (
        <div className="space-y-1">
          <p className="text-sm font-semibold">Notifications are blocked</p>
          <p className="tiny muted">
            {typeof navigator !== "undefined" && isIos()
              ? "iPhone: open Settings ▸ Notifications ▸ KhataLink and turn on Allow Notifications, then come back here. If KhataLink is not listed, delete the Home Screen app and add it again from Safari."
              : "Allow notifications for this site in your browser's site settings, then reload this page."}
          </p>
          <button className="btn btn-sm" onClick={() => void refresh()}>
            Check again
          </button>
        </div>
      ) : null}

      {phase === "off" ? (
        <div className="space-y-2">
          <p className="tiny muted">Off on this device.</p>
          <button className="btn btn-primary w-full" disabled={busy} onClick={() => void enable()}>
            {busy ? "Turning on…" : "Enable notifications"}
          </button>
        </div>
      ) : null}

      {phase === "on" ? (
        <div className="space-y-2">
          {TOGGLES.map((t) => (
            <button
              key={t.kind}
              type="button"
              role="switch"
              aria-checked={prefs[t.kind]}
              className={`btn w-full justify-between text-left ${prefs[t.kind] ? "btn-credit" : ""}`}
              style={{ minHeight: 44 }}
              onClick={() => void toggle(t.kind)}
            >
              <span>
                <span className="block">{t.label}</span>
                <span className="tiny muted block font-normal">{t.hint}</span>
              </span>
              <span aria-hidden>{prefs[t.kind] ? "On" : "Off"}</span>
            </button>
          ))}
          <div className="grid grid-cols-2 gap-2">
            <button className="btn btn-sm" disabled={busy} onClick={() => void sendTest()}>
              Send test
            </button>
            <button className="btn btn-sm btn-debit" disabled={busy} onClick={() => void turnOff()}>
              Turn off
            </button>
          </div>
        </div>
      ) : null}

      {msg ? (
        <p className="tiny" role="status">
          {msg}
        </p>
      ) : null}
    </div>
  );
}
