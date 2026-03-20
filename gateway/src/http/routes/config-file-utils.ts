import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getWorkspaceDir } from "../../credential-reader.js";

/**
 * Serializes config writes so concurrent PATCH requests don't race on
 * read-modify-write. Each write awaits the previous one before proceeding.
 *
 * This chain is shared across all config mutation routes (feature flags,
 * privacy config, etc.) to prevent concurrent writes to the same
 * config.json from overwriting each other's changes.
 */
let configWriteChain: Promise<void> = Promise.resolve();

/**
 * Enqueue a write operation onto the shared config write chain.
 * The callback runs only after all previously enqueued writes have finished.
 */
export function enqueueConfigWrite(fn: () => void): void {
  configWriteChain = configWriteChain.then(fn);
}

export function getConfigPath(): string {
  return join(getWorkspaceDir(), "config.json");
}

export type ConfigReadResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: "malformed"; detail: string };

export function readConfigFile(): ConfigReadResult {
  const cfgPath = getConfigPath();
  if (!existsSync(cfgPath)) {
    return { ok: true, data: {} };
  }
  try {
    const raw = readFileSync(cfgPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        reason: "malformed",
        detail: "Config file is not a JSON object",
      };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    return { ok: false, reason: "malformed", detail: String(err) };
  }
}

/**
 * Atomically write the config file: write to a temporary file in the same
 * directory, then rename. This avoids partial-file corruption if the process
 * crashes mid-write.
 */
export function writeConfigFileAtomic(data: Record<string, unknown>): void {
  const cfgPath = getConfigPath();
  const dir = dirname(cfgPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = join(dir, `.config.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, cfgPath);
}
