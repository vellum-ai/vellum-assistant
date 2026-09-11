import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { withCredentialCompletion } from "../security/credential-completion.js";
import { getSignalsDir } from "../util/platform.js";

interface CredentialLock {
  generation: string;
  owner_pid: number | null;
  owner_token: string | null;
}

function openCoordination(): Database {
  const directory = getSignalsDir();
  mkdirSync(directory, { recursive: true });
  const db = new Database(
    join(directory, "mcp-credential-coordination.sqlite"),
  );
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec(`CREATE TABLE IF NOT EXISTS credential_locks (
    server_key TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    owner_pid INTEGER,
    owner_token TEXT
  )`);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

function keyFor(serverId: string): string {
  return createHash("sha256").update(serverId).digest("hex");
}

function ensureLock(db: Database, key: string): CredentialLock {
  db.query(
    "INSERT OR IGNORE INTO credential_locks (server_key, generation) VALUES (?, ?)",
  ).run(key, randomUUID());
  return db
    .query<
      CredentialLock,
      [string]
    >("SELECT generation, owner_pid, owner_token FROM credential_locks WHERE server_key = ?")
    .get(key)!;
}

function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function readMcpCredentialGeneration(serverId: string): string {
  const db = openCoordination();
  try {
    return ensureLock(db, keyFor(serverId)).generation;
  } finally {
    db.close();
  }
}

interface CredentialLease {
  generation(): string;
  advance(): void;
}

/** SQLite arbitrates async CES writers across the assistant and its workers. */
export async function withMcpCredentialLock<T>(
  serverId: string,
  operation: (lease: CredentialLease) => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  const db = openCoordination();
  const key = keyFor(serverId);
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  try {
    ensureLock(db, key);
    const acquire = db.transaction(() => {
      const current = ensureLock(db, key);
      if (current.owner_pid !== null && ownerIsAlive(current.owner_pid)) {
        return false;
      }
      db.query(
        "UPDATE credential_locks SET owner_pid = ?, owner_token = ? WHERE server_key = ?",
      ).run(process.pid, token, key);
      return true;
    });
    while (!acquired) {
      acquired = acquire.immediate();
      if (acquired) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error("MCP credential storage is busy; retry the operation");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    return await withCredentialCompletion(() =>
      operation({
        generation: () => ensureLock(db, key).generation,
        advance: () => {
          db.query(
            "UPDATE credential_locks SET generation = ? WHERE server_key = ? AND owner_token = ?",
          ).run(randomUUID(), key, token);
        },
      }),
    );
  } finally {
    try {
      if (acquired) {
        db.query(
          "UPDATE credential_locks SET owner_pid = NULL, owner_token = NULL WHERE server_key = ? AND owner_token = ?",
        ).run(key, token);
      }
    } finally {
      db.close();
    }
  }
}

export interface McpCredentialFence {
  write<T>(operation: () => Promise<T>): Promise<T>;
  close(): void;
}

export function createMcpCredentialFence(
  serverId: string,
  isCurrent: () => boolean | Promise<boolean> = () => true,
): McpCredentialFence {
  const generation = readMcpCredentialGeneration(serverId);
  let closed = false;
  return {
    write: (operation) =>
      withMcpCredentialLock(serverId, async (lease) => {
        const current = await isCurrent();
        if (closed || generation !== lease.generation() || !current) {
          throw new Error("MCP connection changed; retry connecting");
        }
        return operation();
      }),
    close: () => {
      closed = true;
    },
  };
}
