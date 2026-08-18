import fs from "node:fs";
import path from "node:path";

import { guardianTokenPath } from "./config";
import {
  readRawLockfile,
  writeRawLockfile,
  type WriteResult,
} from "./lockfile";
import { resolveCloud } from "./lockfile-contract";
import { withLockfileLock } from "./lockfile-lock";

/**
 * Forget a paired assistant on this machine: remove its lockfile entry and
 * delete its stored guardian token. Client-side only, mirroring the CLI's
 * `vellum unpair`: the remote assistant itself is never touched (host-side
 * device revocation is `vellum devices`). Only pairing records
 * (`cloud: "paired"`, created by `vellum connect import`) are forgettable this
 * way; local and managed assistants go through retire.
 */
export function unpairAssistant(
  lockfilePaths: string[],
  configDir: string,
  assistantId: string,
): WriteResult {
  // The whole transaction holds the shared write lock so a concurrent
  // read-modify-write (e.g. a persona-name rename) cannot restore the entry
  // after its credential is deleted.
  const locked = withLockfileLock(lockfilePaths, (): WriteResult =>
    unpairAssistantLocked(lockfilePaths, configDir, assistantId),
  );
  if (!locked.ok) {
    return { ok: false, status: 423, error: locked.error };
  }
  return locked.value;
}

function unpairAssistantLocked(
  lockfilePaths: string[],
  configDir: string,
  assistantId: string,
): WriteResult {
  const lockfile = readRawLockfile(lockfilePaths);
  const assistants = Array.isArray(lockfile.assistants)
    ? (lockfile.assistants as Array<Record<string, unknown>>)
    : [];
  const entry = assistants.find((a) => a?.assistantId === assistantId);
  if (!entry) {
    return { ok: false, status: 404, error: "No such assistant" };
  }
  if (resolveCloud(entry) !== "paired") {
    return {
      ok: false,
      status: 400,
      error:
        "Only paired assistants can be unpaired. Use retire for local or managed assistants.",
    };
  }

  // Delete the token BEFORE committing the lockfile removal. A failed delete
  // aborts with the entry intact, so unpair stays retryable; the reverse order
  // would strand the credential on disk forever (the retry 404s on the
  // already-removed entry and never reaches cleanup). The token contents are
  // kept in memory so a failed lockfile write below can restore them.
  const tokenPath = guardianTokenPath(configDir, assistantId);
  let savedToken: string | null = null;
  try {
    savedToken = fs.readFileSync(tokenPath, "utf-8");
  } catch {
    savedToken = null;
  }
  try {
    fs.rmSync(tokenPath, { force: true });
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: `Failed to delete the stored guardian token: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  try {
    fs.rmdirSync(path.dirname(tokenPath));
  } catch {
    // Directory not empty or absent.
  }

  const remaining = assistants.filter((a) => a?.assistantId !== assistantId);
  lockfile.assistants = remaining;
  // Reassign the active assistant like the CLI's removeAssistantEntry does, so
  // unpairing through the bridge and through `vellum unpair` leave the same
  // active state. Skip tolerated malformed entries (no string assistantId):
  // parseLockfile drops them from the returned lockfile, so pointing at one
  // would report no active assistant while valid entries remain.
  if (lockfile.activeAssistant === assistantId) {
    const next = remaining.find(
      (a) => typeof a?.assistantId === "string",
    )?.assistantId;
    if (typeof next === "string") {
      lockfile.activeAssistant = next;
    } else {
      delete lockfile.activeAssistant;
    }
  }

  const result = writeRawLockfile(lockfilePaths, lockfile);
  if (!result.ok && savedToken !== null) {
    // The entry is still listed, so put its credential back (best-effort;
    // the write failure itself is what gets reported).
    try {
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tokenPath, savedToken, { mode: 0o600 });
    } catch {
      // Restore failed; the reported write error already covers the outcome.
    }
  }
  return result;
}
