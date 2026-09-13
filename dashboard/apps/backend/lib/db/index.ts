import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "dashboard.db");
const MIGRATIONS_DIR = path.join(process.cwd(), "lib", "db", "migrations");

// Survive dev HMR: one connection per process, opened + migrated exactly once.
const globalForDb = globalThis as unknown as { __dashboardDb?: Db };

function create(): Db {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  // apply any pending migrations in-process (idempotent)
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

/** Lazily open (and migrate) the database, caching the handle for the process. */
export function getDb(): Db {
  if (!globalForDb.__dashboardDb) {
    globalForDb.__dashboardDb = create();
  }
  return globalForDb.__dashboardDb;
}
