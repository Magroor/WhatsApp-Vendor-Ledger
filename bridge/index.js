/**
 * KhataLink PC Bridge — automatic capture from your normal WhatsApp.
 *
 * Runs on a computer that stays on, as a "linked device" of your WhatsApp (like
 * WhatsApp Web). For every new message in a chat with one of your SAVED VENDORS
 * it sends the text / bill photo to your KhataLink app, which reads it and posts
 * the ledger entry. It is READ-ONLY: it never sends, replies to or deletes
 * anything. Chats with people who are not saved vendors, groups and status
 * updates are ignored on this computer and never uploaded.
 *
 * NOTE: this uses an unofficial WhatsApp Web client. It is against WhatsApp's
 * terms of service and the account could be restricted. Use at your own risk.
 */
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

const APP_URL = (process.env.APP_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.CAPTURE_TOKEN || "";
const MAX_BYTES = 4_000_000; // the app / Vercel reject bigger uploads
const started = Date.now();

if (!APP_URL || !TOKEN) {
  console.error("Set APP_URL and CAPTURE_TOKEN in bridge/.env (see .env.example).");
  process.exit(1);
}

const last10 = (v) => String(v || "").replace(/\D/g, "").slice(-10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = { Authorization: `Bearer ${TOKEN}` };

/* ---------------------------------------------------------- vendor numbers */
let vendorKeys = new Set();
async function refreshVendors() {
  try {
    const res = await fetch(`${APP_URL}/api/capture`, { headers: auth });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    vendorKeys = new Set((json.vendors || []).map((v) => last10(v.phone)).filter((k) => k.length >= 7));
    console.log(`[bridge] watching ${vendorKeys.size} vendor chat(s)`);
  } catch (e) {
    console.error(`[bridge] could not load vendors (${e.message}); keeping the previous list`);
  }
}

/* -------------------------------------------------------------- upload bill */
async function upload({ number, externalId, text, media }) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const form = new FormData();
      form.set("phone", number);
      form.set("externalId", externalId);
      if (text) form.set("text", text);
      if (media) {
        form.append("image", new Blob([Buffer.from(media.data, "base64")], { type: media.mimetype }), "bill");
      }
      const res = await fetch(`${APP_URL}/api/capture`, { method: "POST", headers: auth, body: form });
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: json.error || `HTTP ${res.status}` };
      return { ok: true, summary: json.summary, skipped: json.skipped, duplicate: json.duplicate };
    } catch (e) {
      if (attempt === 4) return { ok: false, error: e.message };
      await sleep(2000 * attempt * attempt);
    }
  }
}

/* ----------------------------------------------------------------- WhatsApp */
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
  puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});

client.on("qr", (qr) => {
  console.log("\nScan this QR code with your phone:");
  console.log("WhatsApp → Settings → Linked Devices → Link a Device\n");
  qrcode.generate(qr, { small: true });
});
client.on("authenticated", () => console.log("[bridge] linked"));
client.on("auth_failure", (m) => {
  console.error("[bridge] login failed:", m);
  process.exit(1);
});
client.on("ready", async () => {
  console.log("[bridge] ready — new vendor messages will be added automatically");
  await refreshVendors();
  setInterval(refreshVendors, 5 * 60 * 1000);
});
client.on("disconnected", (reason) => {
  console.error("[bridge] disconnected:", reason, "— restarting");
  process.exit(1); // run it under a restart loop (see README)
});

// message_create fires for messages you receive AND ones you send.
client.on("message_create", async (msg) => {
  try {
    if (msg.isStatus || msg.from === "status@broadcast") return;
    if (msg.timestamp * 1000 < started - 60_000) return; // never replay old history
    const isMedia = msg.hasMedia && (msg.type === "image" || msg.type === "document");
    if (msg.type !== "chat" && !isMedia) return; // skip voice notes, stickers, calls, etc.

    const chat = await msg.getChat();
    if (chat.isGroup) return;
    const contact = await chat.getContact();
    const number = contact.number || chat.id.user;
    if (!vendorKeys.has(last10(number))) return; // not a saved vendor: ignore, upload nothing

    const text = (msg.body || "").trim();
    let media = null;
    if (isMedia) {
      const m = await msg.downloadMedia();
      const okType = m && (m.mimetype.startsWith("image/") || m.mimetype === "application/pdf");
      if (!okType) return;
      if (Buffer.byteLength(m.data, "base64") > MAX_BYTES) {
        console.warn("[bridge] a bill photo was over 4 MB and was skipped");
        return;
      }
      media = m;
    }
    if (!text && !media) return;

    const result = await upload({ number, externalId: msg.id._serialized, text, media });
    if (result.ok) {
      if (!result.skipped && !result.duplicate && /^(Added|Read|Saved)/.test(result.summary || "")) {
        console.log(`[bridge] ${result.summary}`);
      }
    } else {
      console.error(`[bridge] upload failed: ${result.error}`);
    }
  } catch (e) {
    console.error("[bridge] error:", e.message);
  }
});

client.initialize();
