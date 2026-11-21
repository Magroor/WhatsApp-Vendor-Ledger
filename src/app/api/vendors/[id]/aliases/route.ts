import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { vendorAliases } from "@/db/schema";
import { fail, ok, parseId } from "@/lib/api";
import { listAliases } from "@/lib/aliases";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const vendorId = parseId((await params).id);
  if (!vendorId) return fail("invalid id");
  return ok({ aliases: await listAliases(vendorId) });
}

/** Forget one learned name or number: DELETE ?aliasId=123 */
export async function DELETE(req: Request, { params }: Ctx) {
  const vendorId = parseId((await params).id);
  const aliasId = parseId(new URL(req.url).searchParams.get("aliasId"));
  if (!vendorId || !aliasId) return fail("invalid id");
  await db.delete(vendorAliases).where(and(eq(vendorAliases.id, aliasId), eq(vendorAliases.vendorId, vendorId)));
  return ok({ deleted: aliasId });
}
