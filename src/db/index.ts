import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";

/**
 * Database selection:
 *  - DATABASE_URL set  -> real Postgres (production / hosted).
 *  - DATABASE_URL unset -> embedded PGlite stored in ./.data/pglite so the app
 *    runs locally with zero setup. Same SQL dialect, so behaviour is identical.
 */
const databaseUrl = process.env.DATABASE_URL;

type G = typeof globalThis & {
  __ledgerPool?: Pool;
  __ledgerLite?: PGlite;
};
const g = globalThis as G;

export const usingEmbedded = !databaseUrl;

// Hosted serverless disks are read-only except /tmp (and wiped between runs), so
// the embedded fallback there is only a safety net: set DATABASE_URL for real use.
// Local test database lives OUTSIDE the project folder: inside it, every database write looks like
// a code change to Next's file watcher and the page reloads in an endless loop while developing.
const liteDir =
  process.env.PGLITE_DIR || (process.env.VERCEL ? "/tmp/pglite" : path.join(homedir(), ".khatalink", "pglite"));
if (!databaseUrl) mkdirSync(liteDir, { recursive: true });

export const pool: Pool | undefined = databaseUrl
  ? (g.__ledgerPool ?? (g.__ledgerPool = new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 15_000 })))
  : undefined;

export const lite: PGlite | undefined = databaseUrl
  ? undefined
  : (g.__ledgerLite ?? (g.__ledgerLite = new PGlite(liteDir)));

// Both drivers expose the same query-builder surface; typed as the pg flavour.
export const db = (databaseUrl
  ? drizzlePg(pool as Pool)
  : drizzlePglite(lite as PGlite)) as unknown as NodePgDatabase;
