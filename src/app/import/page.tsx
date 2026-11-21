import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { vendors } from "@/db/schema";
import ExportGuide from "@/components/ExportGuide";
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
        Add a whole WhatsApp chat at once, for catching up on old months. Works with your normal WhatsApp. For a single new bill, use <b>Add a bill</b> on the Home page instead.
      </p>

      <ExportGuide />

      <ImportChat vendors={list} />

      <details className="card">
        <summary className="h2 tap-link cursor-pointer">Advanced: skip the file step with an iPhone Shortcut</summary>
        <p className="tiny muted mt-2">
          A Shortcut can add “KhataLink Import” to the share sheet so you never browse for the file. It takes a few minutes to set up
          (Guide, step 4) and has <b>not been tested on a real iPhone yet</b>. The steps above always work.
        </p>
      </details>
    </div>
  );
}
