import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { withCredentialCompletion } from "../security/credential-completion.js";
import { getSignalsDir } from "../util/platform.js";

interface CredentialLock {
  generation: string;
  owner_pid: number | null;
  owner_token: string | null;
  owner_instance: string | null;
}

function processInstance(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    if (process.platform === "linux") {
      const boot = readFileSync(
        "/proc/sys/kernel/random/boot_id",
        "utf8",
      ).trim();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return started ? `${boot}:${started}` : null;
    }
    const started =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
            ],
            {
              encoding: "utf8",
              windowsHide: true,
              timeout: 2_000,
              stdio: ["ignore", "pipe", "ignore"],
            },
          )
        : execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 2_000,
            env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
            stdio: ["ignore", "pipe", "ignore"],
          });
    return started.trim() || null;
  } catch {
    return null;
  }
}

let ownInstance: string | undefined;

function currentProcessInstance(): string {
  if (!ownInstance) {
    const instance = processInstance(process.pid);
    ownInstance =
      instance === null ? `local:${randomUUID()}` : `os:${instance}`;
  }
  return ownInstance;
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
    owner_token TEXT,
    owner_instance TEXT
  )`);
    db.transaction(() => {
      const columns = db
        .query<{ name: string }, []>("PRAGMA table_info(credential_locks)")
        .all();
      if (!columns.some((column) => column.name === "owner_instance")) {
        db.exec("ALTER TABLE credential_locks ADD COLUMN owner_instance TEXT");
      }
    }).immediate();
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
    >("SELECT generation, owner_pid, owner_token, owner_instance FROM credential_locks WHERE server_key = ?")
    .get(key)!;
}

function ownerIsAlive(owner: CredentialLock): boolean {
  const pid = owner.owner_pid;
  if (pid === null) {
    return false;
  }
  const prefix = `${owner.owner_token}:`;
  const recordedInstance =
    owner.owner_token && owner.owner_instance?.startsWith(prefix)
      ? owner.owner_instance.slice(prefix.length)
      : null;
  if (pid === process.pid) {
    return recordedInstance === currentProcessInstance();
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (!recordedInstance?.startsWith("os:")) {
    return true;
  }
  const instance = processInstance(pid);
  return instance === null || `os:${instance}` === recordedInstance;
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
  const instance = `${token}:${currentProcessInstance()}`;
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  try {
    ensureLock(db, key);
    while (!acquired) {
      const current = ensureLock(db, key);
      if (!ownerIsAlive(current)) {
        acquired =
          db
            .query(
              "UPDATE credential_locks SET owner_pid = ?, owner_token = ?, owner_instance = ? WHERE server_key = ? AND owner_pid IS ? AND owner_token IS ? AND owner_instance IS ?",
            )
            .run(
              process.pid,
              token,
              instance,
              key,
              current.owner_pid,
              current.owner_token,
              current.owner_instance,
            ).changes === 1;
      }
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
          "UPDATE credential_locks SET owner_pid = NULL, owner_token = NULL, owner_instance = NULL WHERE server_key = ? AND owner_token = ?",
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
