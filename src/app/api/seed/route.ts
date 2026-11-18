import { ok, readJson } from "@/lib/api";
import { seedDemoData } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson<{ force?: boolean }>(req);
  const result = await seedDemoData(Boolean(body.force));
  return ok(result, 201);
}

export async function GET() {
  const result = await seedDemoData(false);
  return ok(result);
}
