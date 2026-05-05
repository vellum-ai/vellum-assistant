import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getWorkspaceDir } from "./credential-reader.js";

export const CONFIG_FILENAME = "config.json";

/**
 * Serializes config writes so concurrent config mutations don't race on
 * read-modify-write. Each write awaits the previous one before proceeding.
 *
 * This chain is shared across all gateway config mutations to prevent
 * concurrent writes to the same config.json from overwriting each other's
 * changes.
 */
let configWriteChain: Promise<void> = Promise.resolve();

/**
 * Enqueue a write operation onto the shared config write chain.
 * The callback runs only after all previously enqueued writes have finished.
 */
export function enqueueConfigWrite(
  fn: () => void | Promise<void>,
): Promise<void> {
  const run = configWriteChain.then(fn);
  configWriteChain = run.catch(() => {});
  return run;
}

export type ConfigMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "malformed"; detail: string };

export function mutateConfigFile<T>(
  mutate: (data: Record<string, unknown>) => T,
  options?: {
    shouldWrite?: (value: T) => boolean;
    onWritten?: () => void;
  },
): Promise<ConfigMutationResult<T>> {
  let mutationResult: ConfigMutationResult<T> | undefined;

  return enqueueConfigWrite(() => {
    const result = readConfigFile();
    if (!result.ok) {
      mutationResult = result;
      return;
    }

    const value = mutate(result.data);
    const shouldWrite = options?.shouldWrite?.(value) ?? true;
    if (shouldWrite) {
      writeConfigFileAtomic(result.data);
      options?.onWritten?.();
    }
    mutationResult = { ok: true, value };
  }).then(() => {
    if (!mutationResult) {
      throw new Error("Config mutation did not produce a result");
    }
    return mutationResult;
  });
}

export function getConfigPath(): string {
  return join(getWorkspaceDir(), CONFIG_FILENAME);
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

export function readConfigFileOrEmpty(options?: {
  onMalformed?: (detail: string) => void;
}): Record<string, unknown> {
  const result = readConfigFile();
  if (result.ok) return result.data;
  options?.onMalformed?.(result.detail);
  return {};
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
