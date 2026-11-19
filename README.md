# KhataLink — WhatsApp Vendor Ledger (iPhone web app)

Tracks credit (bills you owe) and debit (payments) for each vendor, from WhatsApp messages, with weekly / monthly / yearly reports. It is an installable web app (PWA): iPhone users add it to the Home Screen from Safari — no App Store.

## What it does
| Need | How |
|---|---|
| Get WhatsApp messages in (easiest first) | (A) **Import chat** from WhatsApp "Export Chat" — works with normal WhatsApp. (B) Paste a message in Inbox. (C) **Automatic** via WhatsApp Business Cloud API webhook, incl. photo bills (needs a vision key). |
| Text or image bills | Text parsed by rules (English + Roman Urdu); images read by Claude/OpenAI vision. |
| Separate ledger per vendor | Each vendor has its own entries, running balance, items and source message/image. |
| Order details | Items, quantity, unit, rate parsed from bills. |
| Reports | Weekly, monthly, yearly; per vendor or all; credit/debit, opening/closing balance, aging; CSV share + print/PDF. |

## Easiest ways to add bills (no WhatsApp Business needed)
- **📷 Scan bill** in the Inbox: take a photo / pick a WhatsApp screenshot. The vendor is found from the name on the bill.
- **iPhone Share menu:** WhatsApp photo or text → Share → KhataLink (3-minute Shortcut setup in the in-app Guide, step 4; needs `CAPTURE_TOKEN`).
- **Hands-free PC bridge:** a program on an always-on PC watches your saved vendors' chats (no extra SIM, no Meta). Unofficial, read-only. See `bridge/README.md`.
- **Import chat** (Export Chat) for old months, **paste** in the Inbox, or a **Business number** for full automation.
Photos need `GEMINI_API_KEY` (free). Uploaded photos are stored in the database (~300 KB each) for the audit trail.

## 1. Try it on your computer (2 minutes)
```powershell
npm install
npm run dev
```
Open http://localhost:3000, go to **Settings → Load demo data**. With no `DATABASE_URL` it uses a built-in local database in `.data/`.

Checks: `npm run typecheck`, `npm run lint`, `npm run build`, and open `/api/selftest` (all checks should pass).

## 2. Put it online (needed for iPhone)
1. Create a free Postgres database (Neon or Supabase) and copy its connection URL.
2. Upload the project to GitHub, import it in **Vercel** (or Railway).
3. Set environment variables (see `.env.example`): `DATABASE_URL`, `APP_PASSWORD`, `BUSINESS_TIMEZONE`.
   Tables are created automatically on first start from the `drizzle/` folder.
4. Open the https address you get. Sign in with `APP_PASSWORD`.

### Free alternative: Render (instead of Vercel)
1. Database: create a free project at **neon.tech** and copy the connection string (do not use Render's free Postgres — it expires after 30 days).
2. Put the project on a private GitHub repo.
3. render.com → **New → Blueprint** → pick the repo (it reads `render.yaml`). Enter `DATABASE_URL` and `APP_PASSWORD` when asked.
4. Wait for the build, then open `https://khatalink.onrender.com` (your name may differ) and check `/api/health`.
Note: the free plan sleeps after 15 minutes idle, so the first open or first WhatsApp message can take about a minute. Meta retries the webhook and the app ignores duplicates, so nothing is lost.

## 3. Install on iPhone
Safari → open the address → **Share** → **Add to Home Screen** → **Add**. (iOS 16.4+; must be Safari and https.)

## 4. Daily use
1. **Vendors → Add vendor** (name, number with country code, credit days).
2. **Import**: in WhatsApp open vendor chat → name → **Export Chat → Without Media** → Save to Files. In the app open **Import**, choose vendor + file, untick wrong rows, tap Import.
3. **Inbox → Needs review**: fix unclear messages (credit = you owe, debit = you paid).
4. **Reports**: pick Weekly/Monthly/Yearly (+ vendor) → Share CSV or Print/PDF → Save to Files.

## 5. Automatic WhatsApp (optional)
Needs a Meta developer account and a phone number **not** used in normal WhatsApp (Apple/WhatsApp do not allow apps to read a personal WhatsApp).
1. developers.facebook.com → create app → add **WhatsApp**.
2. Configuration → Callback URL `https://YOUR-ADDRESS/api/webhook/whatsapp`; Verify token = value in app **Settings** (or `WHATSAPP_VERIFY_TOKEN`). Subscribe to **messages**.
3. Set `WHATSAPP_TOKEN` (permanent token), `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`.
4. For photo bills set `GEMINI_API_KEY` (free, from aistudio.google.com/apikey) — or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
5. Send a test message from a vendor; it appears in Inbox. In production, unsigned webhooks are rejected.
The webhook stays public (Meta must reach it); everything else needs the password.

## Known limits
- Cloud API only receives messages sent to the business number; the media link expires, so images must be fetched soon after arrival.
- Photo reading and live WhatsApp calls were not tested with real keys.
- Not tested on a physical iPhone.
- Web push notifications are not implemented.
- Offline: pages show last-loaded data; edits are not queued offline.
