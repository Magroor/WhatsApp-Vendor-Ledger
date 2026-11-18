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
        Works with your normal WhatsApp — no business account needed.
      </p>
      <details className="card">
        <summary className="h2 cursor-pointer">How to export a chat from WhatsApp</summary>
        <ol className="tiny muted mt-2 list-decimal space-y-1 pl-5">
          <li>Open the chat with the vendor in WhatsApp.</li>
          <li>Tap the vendor&apos;s name at the top, then scroll down to <b>Export Chat</b>.</li>
          <li>Choose <b>Without Media</b>.</li>
          <li>In the share sheet choose <b>Save to Files</b>, then pick that file below.</li>
        </ol>
        <p className="tiny muted mt-2">
          Bills sent only as photos are not in the export. Photos need the WhatsApp Business setup (see the Guide).
        </p>
      </details>
      <ImportChat vendors={list} />
    </div>
  );
}
