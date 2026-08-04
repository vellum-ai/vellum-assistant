import fs from "node:fs";

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

  lockfile.assistants = assistants.filter(
    (a) => a?.assistantId !== assistantId,
  );
  if (lockfile.activeAssistant === assistantId) {
    lockfile.activeAssistant = null;
  }

  const result = writeRawLockfile(lockfilePaths, lockfile);
  if (!result.ok) {
    return result;
  }

  fs.rmSync(guardianTokenPath(configDir, assistantId), { force: true });
  return result;
}
