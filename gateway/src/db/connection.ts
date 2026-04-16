import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getGatewaySecurityDir, getLegacyRootDir } from "../paths.js";
import { runDataMigrations } from "./data-migrations/index.js";
import * as schema from "./schema.js";

export type GatewayDb = ReturnType<typeof drizzle<typeof schema>>;

let db: GatewayDb | null = null;

/**
 * One-time migration: move gateway.sqlite from the legacy path
 * (~/.vellum/data/gateway.sqlite) to the new PVC-backed path
 * ({gatewaySecurityDir}/gateway.sqlite). Idempotent — skips if
 * the new path already exists or the old path doesn't.
 */
function migrateLegacyDb(newPath: string): void {
  const legacyPath = join(getLegacyRootDir(), "data", "gateway.sqlite");
  if (legacyPath === newPath) return;
  if (existsSync(newPath)) return;
  if (!existsSync(legacyPath)) return;

  try {
    renameSync(legacyPath, newPath);
  } catch {
    return;
  }

  for (const suffix of ["-wal", "-shm"]) {
    try {
      const old = legacyPath + suffix;
      if (existsSync(old)) renameSync(old, newPath + suffix);
    } catch {
      // Best-effort
    }
  }
}

function getDbPath(): string {
  const securityDir = getGatewaySecurityDir();
  if (!existsSync(securityDir)) {
    mkdirSync(securityDir, { recursive: true });
  }
  const dbPath = join(securityDir, "gateway.sqlite");
  migrateLegacyDb(dbPath);
  return dbPath;
}

/**
 * Initialize the gateway database: open connection, push schema, run
 * data migrations. Must be called (and awaited) once at startup before
 * any code calls getGatewayDb().
 *
 * Uses drizzle-kit's pushSQLiteSchema to diff schema.ts against the
 * live database and apply any missing tables/columns/indexes. No
 * migration files needed — schema.ts is the single source of truth.
 */
export async function initGatewayDb(): Promise<void> {
  if (db) return;

  const raw = new Database(getDbPath());
  raw.exec("PRAGMA journal_mode=WAL");
  raw.exec("PRAGMA synchronous=FULL");
  raw.exec("PRAGMA busy_timeout=5000");
  raw.exec("PRAGMA foreign_keys=ON");

  db = drizzle(raw, { schema });

  const { pushSQLiteSchema } = await import("drizzle-kit/api");
  const { statementsToExecute, apply } = await pushSQLiteSchema(
    schema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pushSQLiteSchema types against LibSQLDatabase; BunSQLiteDatabase is duck-type compatible
    db as any,
  );
  if (statementsToExecute.length > 0) {
    await apply();
  }

  runDataMigrations(getRawDb(db));
}

/**
 * Get the typed Drizzle ORM instance for the gateway database.
 *
 * Requires initGatewayDb() to have been called first.
 */
export function getGatewayDb(): GatewayDb {
  if (!db) {
    throw new Error(
      "Gateway DB not initialized — call initGatewayDb() at startup",
    );
  }
  return db;
}

/**
 * Extract the underlying bun:sqlite Database from a Drizzle instance.
 * Internal helper — not exported. Production code should use getGatewayDb()
 * with Drizzle's query API. Only needed for data migrations and test cleanup.
 */
function getRawDb(drizzleDb: GatewayDb): Database {
  return (drizzleDb as unknown as { $client: Database }).$client;
}

/**
 * Reset the singleton so the next initGatewayDb() creates a fresh
 * connection. Test-only — never call in production code.
 */
export function resetGatewayDb(): void {
  if (db) {
    try {
      getRawDb(db).close();
    } catch {
      // best effort
    }
  }
  db = null;
}
