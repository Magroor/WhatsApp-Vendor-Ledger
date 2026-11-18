import { mkdirSync } from "node:fs";
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

const liteDir = process.env.PGLITE_DIR || "./.data/pglite";
if (!databaseUrl) mkdirSync(liteDir, { recursive: true });

export const pool: Pool | undefined = databaseUrl
  ? (g.__ledgerPool ?? (g.__ledgerPool = new Pool({ connectionString: databaseUrl })))
  : undefined;

export const lite: PGlite | undefined = databaseUrl
  ? undefined
  : (g.__ledgerLite ?? (g.__ledgerLite = new PGlite(liteDir)));

// Both drivers expose the same query-builder surface; typed as the pg flavour.
export const db = (databaseUrl
  ? drizzlePg(pool as Pool)
  : drizzlePglite(lite as PGlite)) as unknown as NodePgDatabase;
