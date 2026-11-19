import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { vendors } from "@/db/schema";
import ImportChat from "@/components/ImportChat";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const list = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(eq(vendors.archived, false))
    .orderBy(asc(vendors.name));
  return (
    <div className="space-y-4 rise">
      <p className="tiny muted">
        Add a whole WhatsApp chat at once, for catching up on old months. Works with your normal WhatsApp.
      </p>

      <div className="card space-y-2">
        <p className="h2">Easiest: send it straight from WhatsApp</p>
        <ol className="tiny muted list-decimal space-y-1 pl-5">
          <li>In the vendor chat tap the vendor&apos;s name at the top → <b>Export Chat</b> → <b>Without Media</b>.</li>
          <li>In the share sheet tap <b>KhataLink Import</b> (one-time 2-minute setup in the Guide, step 4).</li>
          <li>Done. The vendor is taken from the file name and each bill or payment is added. No file browsing.</li>
        </ol>
      </div>

      <details className="card">
        <summary className="h2 cursor-pointer">Or choose the file here (where to find it)</summary>
        <ol className="tiny muted mt-2 list-decimal space-y-1 pl-5">
          <li>Export the chat as above, then in the share sheet tap <b>Save to Files</b>.</li>
          <li>Pick <b>On My iPhone</b> (or iCloud Drive) and tap <b>Save</b>. Remember the name: &quot;WhatsApp Chat - vendor&quot;.</li>
          <li>Come back here and tap <b>Choose exported file</b> below. In the picker tap <b>Recents</b> at the bottom — the file you just saved is the first one. If not, tap <b>Browse</b> → <b>On My iPhone</b>.</li>
        </ol>
        <p className="tiny muted mt-2">
          Photo-only bills are not in the export. Use <b>Add bills</b> on the Home page for those.
        </p>
      </details>

      <ImportChat vendors={list} />
    </div>
  );
}
