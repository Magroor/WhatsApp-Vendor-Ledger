"use client";

import { useEffect, useRef } from "react";

const HINT_KEY = "khatalink.ios.hint.v1";

/**
 * iOS runtime glue:
 *  - registers the offline service worker
 *  - shows the Add-to-Home-Screen coaching card once per device
 *  - toggles the card through the DOM (no state churn during hydration)
 */
export default function IosRuntime() {
  const hintRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* offline caching is best-effort */
      });
    }
    const el = hintRef.current;
    if (!el) return;
    const seen = window.localStorage.getItem(HINT_KEY) === "seen";
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
    el.style.display = isIos && !standalone && !seen ? "" : "none";
  }, []);

  function remember() {
    window.localStorage.setItem(HINT_KEY, "seen");
    if (hintRef.current) hintRef.current.style.display = "none";
  }

  return (
    <div
      ref={hintRef}
      style={{ display: "none" }}
      className="no-print fixed inset-x-0 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom,0px)+10px)] z-50 px-4"
    >
      <div className="mx-auto max-w-[520px]">
        <div className="card flex items-start gap-3 border-indigo-400/40 bg-indigo-500/15">
          <span className="text-xl">📲</span>
          <div className="flex-1">
            <p className="h2">Install on iPhone</p>
            <p className="tiny muted mt-1">
              Tap <strong>Share</strong> ▸ <strong>Add to Home Screen</strong> to run
              KhataLink full-screen, exactly like a native app.
            </p>
            <button className="btn btn-sm mt-2" onClick={remember}>
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
