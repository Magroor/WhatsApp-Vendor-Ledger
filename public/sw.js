/* KhataLink service worker v2.
   - Pages and API responses are NEVER cached: ledger data is private and must always be fresh
     (v1 cached pages, which showed stale data after updates and kept financial pages on the device).
   - Only immutable, content-hashed build files and the app icons are cached, for speed.
   - If the network is down, navigations get a small "offline" page instead of a browser error. */
const CACHE = "khatalink-v2";
const STATIC = ["/icon.png", "/apple-touch-icon.png", "/manifest.webmanifest"];

const OFFLINE_HTML =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>Offline</title><body style=\"font-family:system-ui;background:#05070f;color:#e8ebf7;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px\">" +
  "<div><h1 style=\"font-size:1.3rem\">You are offline</h1><p>KhataLink needs a connection to show your ledger. " +
  "Reconnect and pull down to refresh.</p><button onclick=\"location.reload()\" style=\"font-size:16px;padding:12px 20px;border-radius:12px;border:0\">Try again</button></div></body>";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC).catch(() => undefined)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never cache API data

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(
        () => new Response(OFFLINE_HTML, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }),
      ),
    );
    return;
  }

  const cacheable = url.pathname.startsWith("/_next/static/") || STATIC.includes(url.pathname);
  if (!cacheable) return;
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ??
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
          }
          return res;
        }),
    ),
  );
});

/* Web Push (see src/lib/push.ts). iOS revokes subscriptions that receive a push without
   showing a notification, so ALWAYS show one, even when the payload is missing or broken. */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "KhataLink";
  const url = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      icon: "/icon.png",
      badge: "/icon.png",
      tag: typeof data.tag === "string" && data.tag ? data.tag : "khatalink",
      renotify: true,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || "/";
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          return client.focus().then((c) => (c && "navigate" in c ? c.navigate(target).catch(() => c) : c));
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    }),
  );
});
