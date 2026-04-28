import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getGatewaySecurityDir, getLegacyRootDir } from "../paths.js";
import { runDataMigrations } from "./data-migrations/index.js";
import * as schema from "./schema.js";
import { seedTrustRulesFromRegistry } from "./seed-trust-rules.js";
import { TrustRuleStore } from "./trust-rule-store.js";

export type GatewayDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * drizzle-kit's pushSQLiteSchema prompts interactively on stdin when it
 * detects ambiguous column changes (new column vs rename of an existing
 * one). In a headless container the prompt hangs forever.
 *
 * Our policy: always "create column", never rename. This wrapper spoofs a
 * TTY and emits Enter keypresses on a timer so drizzle-kit's hanji prompt
 * auto-selects the first option (index 0 = "create column") without human
 * interaction. Works across all current and future ambiguous schema diffs.
 */
async function pushSchemaNoPrompt(
  imports: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pushSQLiteSchema types against LibSQLDatabase; BunSQLiteDatabase is duck-type compatible
  drizzleInstance: any,
): Promise<{ statementsToExecute: string[]; apply: () => Promise<void> }> {
  const stdin = process.stdin as typeof process.stdin & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => typeof process.stdin;
  };
  const origStdinTTY = stdin.isTTY;
  const origStdoutTTY = process.stdout.isTTY;
  const origSetRawMode = stdin.setRawMode;

  // Spoof TTY so hanji's render() doesn't reject / hang
  Object.defineProperty(stdin, "isTTY", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
  });
  if (!origSetRawMode) {
    stdin.setRawMode = () => stdin;
  }

  // Emit Enter at 50ms intervals — auto-selects "create column" (idx 0)
  const interval = setInterval(() => {
    stdin.emit("keypress", "\r", { name: "return" });
  }, 50);

  try {
    const { pushSQLiteSchema } = await import("drizzle-kit/api");
    return await pushSQLiteSchema(imports, drizzleInstance);
  } finally {
    clearInterval(interval);
    Object.defineProperty(stdin, "isTTY", {
      value: origStdinTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: origStdoutTTY,
      configurable: true,
    });
    if (!origSetRawMode) {
      stdin.setRawMode = undefined as unknown as typeof stdin.setRawMode;
    }
  }
}

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

  const { statementsToExecute, apply } = await pushSchemaNoPrompt(schema, db);
  if (statementsToExecute.length > 0) {
    await apply();
  }

  runDataMigrations(getRawDb(db));

  const trustRuleStore = new TrustRuleStore(db);
  seedTrustRulesFromRegistry(trustRuleStore);
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
