import fs from "node:fs";
import path from "node:path";

import { guardianTokenPath } from "./config";
import {
  readRawLockfile,
  writeRawLockfile,
  type WriteResult,
} from "./lockfile";
import { resolveCloud } from "./lockfile-contract";

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

  const remaining = assistants.filter((a) => a?.assistantId !== assistantId);
  lockfile.assistants = remaining;
  // Reassign the active assistant like the CLI's removeAssistantEntry does, so
  // unpairing through the bridge and through `vellum unpair` leave the same
  // active state.
  if (lockfile.activeAssistant === assistantId) {
    const next = remaining[0]?.assistantId;
    if (typeof next === "string") {
      lockfile.activeAssistant = next;
    } else {
      delete lockfile.activeAssistant;
    }
  }

  const result = writeRawLockfile(lockfilePaths, lockfile);
  if (!result.ok) {
    return result;
  }

  // Best-effort, like the CLI's deleteGuardianToken: the entry is already
  // gone from the lockfile, so a failed token delete must not surface as a
  // rejected invoke (retrying would 404 on the missing entry anyway).
  const tokenPath = guardianTokenPath(configDir, assistantId);
  try {
    fs.rmSync(tokenPath, { force: true });
  } catch {
    // Stale token file remains; it is unusable without its lockfile entry.
  }
  try {
    fs.rmdirSync(path.dirname(tokenPath));
  } catch {
    // Directory not empty or absent.
  }
  return result;
}
