export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.AUTO_MIGRATE === "0") return;
  const { ensureMigrated } = await import("./db/migrate");
  await ensureMigrated();
}
