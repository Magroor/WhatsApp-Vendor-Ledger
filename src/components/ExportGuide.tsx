"use client";

import { useState } from "react";

/**
 * Picture-by-picture help for getting a chat out of WhatsApp on an iPhone. Each step draws a
 * simplified copy of the real screen and highlights the one thing to tap, because the iOS share
 * sheet lists many apps and people do not know which to choose (the answer: Save to Files).
 */

const HI = "rounded-lg ring-2 ring-emerald-400 bg-emerald-500/25 animate-pulse";
const ROW = "flex items-center justify-between rounded-lg px-3 py-2 text-[13px]";
const DIM = "text-white/40";

function Phone({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[250px] rounded-[26px] border border-white/20 bg-black/40 p-2" aria-hidden="true">
      <div className="space-y-1 rounded-[20px] bg-slate-900/80 p-2">{children}</div>
    </div>
  );
}

const STEPS: Array<{ title: string; text: string; screen: React.ReactNode }> = [
  {
    title: "Open the vendor's chat",
    text: "In WhatsApp open the chat with the vendor. Tap the vendor's name at the very top.",
    screen: (
      <Phone>
        <div className={`${ROW} bg-emerald-800/60`}>
          <span>←</span>
          <span className={`${HI} px-3 py-1 font-semibold`}>Ahmed Traders</span>
          <span>📞</span>
        </div>
        <div className={`${ROW} ${DIM} bg-white/5`}>Salam bhai, bill bhej diya</div>
        <div className={`${ROW} ${DIM} bg-white/5 justify-end`}>ok shukriya</div>
      </Phone>
    ),
  },
  {
    title: "Tap “Export Chat”",
    text: "Scroll down the vendor's page, nearly to the bottom, until you see Export Chat (in blue or red text).",
    screen: (
      <Phone>
        <div className={`${ROW} ${DIM} bg-white/5`}>Media, Links and Docs</div>
        <div className={`${ROW} ${DIM} bg-white/5`}>Starred Messages</div>
        <div className={`${ROW} ${DIM} bg-white/5`}>Chat Search</div>
        <div className={`${ROW} ${HI} font-semibold`}>
          <span>Export Chat</span>
          <span>⬆︎</span>
        </div>
        <div className={`${ROW} ${DIM} bg-white/5`}>Clear Chat</div>
      </Phone>
    ),
  },
  {
    title: "Choose “Without Media”",
    text: "WhatsApp asks about media. Tap Without Media. It is smaller and faster, and the app only needs the text.",
    screen: (
      <Phone>
        <div className="space-y-2 p-3 text-center text-[12px]">
          <p className="font-semibold">Attach media?</p>
          <div className={`${ROW} justify-center bg-white/10 ${DIM}`}>Attach Media</div>
          <div className={`${ROW} justify-center font-semibold ${HI}`}>Without Media</div>
        </div>
      </Phone>
    ),
  },
  {
    title: "Tap “Save to Files”",
    text: "A white sheet appears with many apps at the top. Ignore all of them. Scroll the list of actions below and tap Save to Files. Not there? Swipe up on the sheet.",
    screen: (
      <Phone>
        <div className="rounded-lg bg-white/10 p-2">
          <p className="mb-1 text-[11px] font-semibold text-white/60">Apps: ignore these</p>
          <div className="flex justify-around text-xl opacity-40">
            <span>💬</span>
            <span>✉️</span>
            <span>📡</span>
            <span>📝</span>
          </div>
        </div>
        <div className={`${ROW} ${DIM} bg-white/5`}>Copy</div>
        <div className={`${ROW} ${DIM} bg-white/5`}>Add to Notes</div>
        <div className={`${ROW} ${HI} font-semibold`}>
          <span>Save to Files</span>
          <span>📁</span>
        </div>
      </Phone>
    ),
  },
  {
    title: "Pick a place and Save",
    text: "Choose On My iPhone, then tap Save at the top right. The file is named “WhatsApp Chat - vendor name”.",
    screen: (
      <Phone>
        <div className={`${ROW} bg-white/5`}>
          <span className={DIM}>Cancel</span>
          <span className="font-semibold">Save</span>
        </div>
        <div className={`${ROW} ${DIM} bg-white/5`}>iCloud Drive</div>
        <div className={`${ROW} ${HI} font-semibold`}>On My iPhone</div>
        <div className={`${ROW} bg-white/10 text-[11px]`}>📄 WhatsApp Chat - Ahmed Traders.zip</div>
      </Phone>
    ),
  },
  {
    title: "Come back here and choose the file",
    text: "In KhataLink tap Choose exported file. iPhone shows a small menu: tap Choose Files (not Photo Library). Then tap Recents at the bottom: your file is first in the list.",
    screen: (
      <Phone>
        <div className={`${ROW} ${DIM} bg-white/5`}>Photo Library</div>
        <div className={`${ROW} ${DIM} bg-white/5`}>Take Photo or Video</div>
        <div className={`${ROW} ${HI} font-semibold`}>
          <span>Choose Files</span>
          <span>📁</span>
        </div>
        <div className={`${ROW} bg-white/10 text-[11px]`}>Recents ▸ 📄 WhatsApp Chat - Ahmed…</div>
      </Phone>
    ),
  },
];

export default function ExportGuide() {
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;

  return (
    <div className="card space-y-3">
      <div>
        <p className="h2">How to get a chat out of WhatsApp</p>
        <p className="tiny muted">6 short steps on iPhone. The answer to “share with which app?” is always <b>Save to Files</b>.</p>
      </div>

      <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm">
        <b>Short version:</b> vendor name → Export Chat → Without Media → <b>Save to Files</b> → On My iPhone → Save.
      </div>

      <div role="group" aria-label={`Step ${i + 1} of ${STEPS.length}`} className="space-y-3">
        <p className="tiny muted font-semibold uppercase tracking-wide">
          Step {i + 1} of {STEPS.length}
        </p>
        <h3 className="text-[16px] font-semibold">{step.title}</h3>
        {step.screen}
        <p className="text-sm leading-relaxed">{step.text}</p>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button className="btn btn-sm" onClick={() => setI((n) => Math.max(0, n - 1))} disabled={i === 0}>
          ← Back
        </button>
        <div className="flex gap-1.5" aria-hidden="true">
          {STEPS.map((_, n) => (
            <span key={n} className={`h-2 w-2 rounded-full ${n === i ? "bg-emerald-400" : "bg-white/25"}`} />
          ))}
        </div>
        <button className="btn btn-sm btn-primary" onClick={() => setI((n) => Math.min(STEPS.length - 1, n + 1))} disabled={last}>
          Next →
        </button>
      </div>
    </div>
  );
}
