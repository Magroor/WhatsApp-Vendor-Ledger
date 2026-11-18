export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.AUTO_MIGRATE === "0") return;
  try {
    const { ensureMigrated } = await import("./db/migrate");
    await ensureMigrated();
  } catch (error) {
    // Never take the whole site down because of a migration problem: log it
    // (visible in the host's runtime logs) and let /api/health report it.
    console.error("[startup] database migration failed:", error);
  }
}
