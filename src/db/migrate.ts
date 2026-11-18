import path from "node:path";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { db, lite, usingEmbedded } from "./index";

let running: Promise<void> | null = null;

/** Apply SQL migrations from ./drizzle once per process. */
export function ensureMigrated(): Promise<void> {
  if (!running) {
    const migrationsFolder = path.join(process.cwd(), "drizzle");
    running = (
      usingEmbedded
        ? migratePglite(db as never, { migrationsFolder })
        : migratePg(db, { migrationsFolder })
    ).catch((error) => {
      running = null;
      throw error;
    });
  }
  return running;
}

export { lite };
