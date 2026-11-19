# KhataLink PC Bridge: automatic capture from your normal WhatsApp

No second SIM, no Meta account. A small program on a computer that stays on, linked to your WhatsApp like WhatsApp Web. New bills in your **saved vendors'** chats are added to KhataLink automatically (text and bill photos).

## Read this first
- **Unofficial.** It uses an unofficial WhatsApp Web client, which is against WhatsApp's terms. The account could be restricted. Read-only and vendor-only lowers the risk but does not remove it. Use at your own risk.
- **Read-only.** It never sends, replies to or deletes anything.
- **Private.** Only chats with phone numbers saved as vendors in KhataLink are uploaded. Everyone else, groups and status updates are ignored on your computer.
- **Needs a computer that stays on** (Windows PC / laptop / mini PC). It cannot run on Vercel.
- It sees **new** messages after it starts. For older months use Import chat in the app.

## One-time setup (about 10 minutes)
1. **Vercel:** add variable `CAPTURE_TOKEN` = a long random secret (30+ letters/digits) and redeploy.
2. **KhataLink:** make sure each vendor is saved with their WhatsApp number including country code (e.g. `923001234567`).
3. On the computer (Node.js 20 or newer installed), open PowerShell in this `bridge` folder:
   ```powershell
   npm install
   copy .env.example .env
   notepad .env
   ```
   In `.env` set `APP_URL` (your KhataLink address) and `CAPTURE_TOKEN` (same secret as Vercel). Save.
4. Start it:
   ```powershell
   npm start
   ```
   A QR code appears. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device** and scan it.
5. When it says `ready` it is working. Leave the window open.

## Check it works
In a vendor chat send a test like `paid Rs 100 cash`. In a few seconds the window prints `Added debit Rs100 to <vendor>` and it appears in the app. Void or delete the test entry afterwards.

## Keeping it running
- Do not close the window or let the computer sleep (Windows: Settings → Power → Sleep: Never).
- It exits if WhatsApp disconnects. Run it in a loop so it restarts:
  ```powershell
  while ($true) { npm start; Start-Sleep 10 }
  ```
- To start at Windows login: Task Scheduler → Create Basic Task → "At log on" → Action: start `powershell.exe` with arguments `-NoExit -Command "cd 'C:\path\to\bridge'; while ($true) { npm start; Start-Sleep 10 }"`.

## Stopping / removing
Press Ctrl+C. To unlink: WhatsApp → Settings → Linked Devices → tap the device → Log out. Delete the `bridge/.wwebjs_auth` folder to forget the login.

## Troubleshooting
- **"Set APP_URL and CAPTURE_TOKEN":** fill in `bridge/.env`.
- **"could not load vendors (HTTP 401)":** the token differs from Vercel's, or Vercel was not redeployed after adding it.
- **Nothing happens for a chat:** the vendor's saved number does not match the chat's number. Check the country code.
- **QR code does not appear / Chrome error:** run `npm install` again (it downloads Chrome), or install Google Chrome and re-run.
