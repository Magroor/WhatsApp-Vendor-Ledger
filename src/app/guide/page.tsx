import Link from "next/link";

export const dynamic = "force-static";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <details className="card" open={n === 1}>
      <summary className="h2 cursor-pointer">
        {n}. {title}
      </summary>
      <div className="tiny muted mt-2 space-y-2 leading-relaxed">{children}</div>
    </details>
  );
}

export default function GuidePage() {
  return (
    <div className="space-y-3 rise">
      <p className="tiny muted">
        Everything you need, in order. Start with step 1 — you can use the app today without any
        WhatsApp setup.
      </p>

      <Step n={1} title="Install on your iPhone">
        <p>
          The app opens from a web address (your administrator gives you this). Open it in{" "}
          <b>Safari</b>, tap the <b>Share</b> button, then <b>Add to Home Screen</b> → <b>Add</b>.
          It now opens full screen like a normal app.
        </p>
        <p>Needs iOS 16.4 or newer for notifications. The address must start with https://.</p>
      </Step>

      <Step n={2} title="Add your vendors">
        <p>
          Go to <Link href="/vendors" className="underline">Vendors</Link> → <b>Add vendor</b>. Enter the
          name, WhatsApp number (with country code, e.g. 923001234567) and credit days. Each vendor
          gets their own separate ledger.
        </p>
      </Step>

      <Step n={3} title="Get bills in — choose the way that fits you">
        <p>
          <b>A. Scan a bill (easiest).</b> Open the <Link href="/inbox" className="underline">Inbox</Link>{" "}
          and tap <b>📷 Take photo / choose picture</b>. Choose a vendor, or leave it on “detect
          automatically” — the vendor name printed on the bill is used. A WhatsApp screenshot works too.
          The amount, credit/debit and items are read and added for you.
        </p>
        <p>
          <b>B. Share from WhatsApp in 2 taps.</b> Open a bill photo or select a vendor&apos;s message,
          tap <b>Share</b> and choose <b>KhataLink</b>. One-time setup (3 minutes) is in step 4.
        </p>
        <p>
          <b>C. Import a whole chat.</b> In WhatsApp open the vendor chat → tap their
          name → <b>Export Chat</b> → <b>Without Media</b> → <b>Save to Files</b>. Then open{" "}
          <Link href="/import" className="underline">Import</Link>, pick the vendor and the file, check
          the list and tap Import. Good for catching up on old months.
        </p>
        <p>
          <b>D. Type or paste one message.</b> In the <Link href="/inbox" className="underline">Inbox</Link>{" "}
          use the capture box: paste the vendor&apos;s message, like “5 hazar rupay mil gaye” or
          “5 bags cement total 7500 udhaar”.
        </p>
        <p>
          <b>E. Fully automatic (WhatsApp Business number).</b> Vendors message a business number and bills appear
          on their own, including photos of bills. This needs a Meta developer account and a number
          that is not already used in normal WhatsApp. See step 7.
        </p>
      </Step>

      <Step n={4} title="Add “KhataLink” to the iPhone Share menu (3 minutes, once)">
        <p>
          Administrator first: in Vercel add the variable <code>CAPTURE_TOKEN</code> with a long random
          secret and redeploy. Keep it private — anyone with it can add entries.
        </p>
        <p>
          On the iPhone open the <b>Shortcuts</b> app → <b>+</b> and build <b>“KhataLink Photo”</b>:
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Tap the <b>ⓘ</b> button → turn on <b>Show in Share Sheet</b> → Share Sheet Types: only <b>Images</b>.</li>
          <li>Add action <b>Resize Image</b> → width <b>1600</b>.</li>
          <li>Add action <b>Convert Image</b> → <b>JPEG</b>.</li>
          <li>
            Add action <b>Get Contents of URL</b>. URL: <code>https://YOUR-ADDRESS/api/capture</code>.
            Tap <b>Show More</b>: Method <b>POST</b>; Headers → add <b>Authorization</b> with value{" "}
            <code>Bearer YOUR_CAPTURE_TOKEN</code>; Request Body <b>Form</b> → add a <b>File</b> field named{" "}
            <code>image</code> = the converted image.
          </li>
          <li>Add <b>Get Dictionary Value</b> for key <code>summary</code>, then <b>Show Notification</b> with it.</li>
        </ol>
        <p>
          Build a second shortcut <b>“KhataLink Text”</b> the same way, but Share Sheet Types: <b>Text</b>,
          skip the two image actions, and add a <b>Text</b> field named <code>text</code> = Shortcut Input.
        </p>
        <p>
          Use it: open a bill photo in WhatsApp → <b>Share</b> → <b>KhataLink Photo</b>. A notification
          says “Added credit Rs 19,500 to Ahmed Traders”. If the vendor can&apos;t be found, the bill waits
          in the Inbox under “Unassigned” so you can choose the vendor.
        </p>
      </Step>

      <Step n={5} title="Check the entries">
        <p>
          Clear messages are added automatically. Unclear ones wait in the{" "}
          <Link href="/inbox" className="underline">Inbox</Link> under “Needs review” — tap one, correct
          the amount or type (credit = you owe, debit = you paid) and confirm. Wrong entries can be
          voided; the history is always kept.
        </p>
      </Step>

      <Step n={6} title="Reports">
        <p>
          Open <Link href="/reports" className="underline">Reports</Link>, choose Weekly, Monthly or
          Yearly, and optionally one vendor. Use <b>Share CSV</b> to send it by WhatsApp or email, or{" "}
          <b>Print / PDF</b> and “Save to Files”.
        </p>
      </Step>

      <Step n={7} title="Automatic WhatsApp setup (optional)">
        <ol className="list-decimal space-y-1 pl-5">
          <li>Create a free app at developers.facebook.com → add the <b>WhatsApp</b> product.</li>
          <li>Add a phone number that is not used in normal WhatsApp.</li>
          <li>
            In WhatsApp → Configuration set Callback URL to <code>https://YOUR-ADDRESS/api/webhook/whatsapp</code>{" "}
            and the Verify token shown in <Link href="/settings" className="underline">Settings</Link>.
            Subscribe to <b>messages</b>.
          </li>
          <li>
            On your server set: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET. For
            photo bills also set GEMINI_API_KEY (free from aistudio.google.com) or ANTHROPIC_API_KEY / OPENAI_API_KEY.
          </li>
          <li>Send a test message from a vendor number and watch it appear in the Inbox.</li>
        </ol>
      </Step>

      <Step n={8} title="Put it online (administrator)">
        <ol className="list-decimal space-y-1 pl-5">
          <li>Create a free Postgres database (Neon or Supabase) and copy its connection URL.</li>
          <li>
            Upload this project to Vercel (or Railway). Set DATABASE_URL, APP_PASSWORD (the login
            password) and, for WhatsApp, the variables in step 6.
          </li>
          <li>Open the https address on the iPhone and follow step 1.</li>
        </ol>
      </Step>

      <Step n={9} title="Good to know">
        <ul className="list-disc space-y-1 pl-5">
          <li>iPhone cannot read your personal WhatsApp directly — that is why Import and Business setup exist.</li>
          <li>Money is stored exactly (no rounding drift).</li>
          <li>If the app shows old data offline, pull down or reopen when online.</li>
        </ul>
      </Step>
    </div>
  );
}
