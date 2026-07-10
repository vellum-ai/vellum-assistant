import { readFileSync, statSync } from "node:fs";

import type { MemoryConfig } from "../../../config/schemas/memory.js";
import { MemoryConfigSchema } from "../../../config/schemas/memory.js";
import { getWorkspaceConfigPath } from "../../../util/platform.js";
import { getLogger } from "./logging.js";

const log = getLogger("memory-config");

let cached: MemoryConfig | null = null;
let cachedSignature: string | null = null;

/**
 * Cheap freshness key for the config file, mirroring the host loader's
 * signature check (path + size + mtime + ctime). The path is part of the key
 * so a process that switches workspaces (tests, CLI helpers) never serves one
 * workspace's cached slice for another's. "absent" when the file is missing
 * or unreadable.
 */
function configFileSignature(path: string): string {
  try {
    const s = statSync(path);
    return `${path}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch {
    return `${path}:absent`;
  }
}

/**
 * The raw `memory` field of workspace/config.json, or `{}` when the file is
 * missing, unparseable, or the field is not a plain object. Matches the host
 * loader's effective outcome for those cases (it quarantines a corrupt file
 * and proceeds with defaults); quarantine itself stays host-owned — this is
 * a side-effect-free read.
 */
function readRawMemoryField(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const memory = (parsed as Record<string, unknown>).memory;
  if (memory === null || typeof memory !== "object" || Array.isArray(memory)) {
    return {};
  }
  return memory as Record<string, unknown>;
}

/**
 * Parse the raw memory field through the schema, mirroring the host loader's
 * per-field fallback: an invalid leaf is stripped so its schema default
 * applies while valid sibling customizations survive. Results are
 * structured-cloned because zod returns its precomputed default sub-objects
 * by reference on every parse.
 *
 * No empty-ancestor pruning (unlike the host's full-config cleanup): every
 * memory sub-schema parses `{}` to its full defaults, so an emptied object is
 * equivalent to an absent one.
 */
function parseMemorySlice(raw: Record<string, unknown>): MemoryConfig {
  const result = MemoryConfigSchema.safeParse(raw);
  if (result.success) {
    return structuredClone(result.data);
  }

  const cleaned = structuredClone(raw);
  for (const issue of result.error.issues) {
    const path = issue.path.join(".");
    log.warn(
      `Invalid memory config${path ? ` at "${path}"` : ""}: ${issue.message}. Falling back to default.`,
    );
    if (issue.path.length === 0) {
      return structuredClone(MemoryConfigSchema.parse({}));
    }
    deleteLeaf(cleaned, issue.path as (string | number)[]);
  }

  const retry = MemoryConfigSchema.safeParse(cleaned);
  if (retry.success) {
    return structuredClone(retry.data);
  }

  log.warn("Memory config validation failed after cleanup. Using defaults.");
  return structuredClone(MemoryConfigSchema.parse({}));
}

/** Delete the leaf at `path`, tolerating already-missing ancestors. */
function deleteLeaf(
  obj: Record<string, unknown>,
  path: (string | number)[],
): void {
  let node: unknown = obj;
  for (const key of path.slice(0, -1)) {
    if (node === null || typeof node !== "object") {
      return;
    }
    node = (node as Record<string | number, unknown>)[key];
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  delete (node as Record<string | number, unknown>)[path.at(-1)!];
}

/**
 * Deployment-context fill for the memory slice, mirroring the memory entry of
 * the host loader's `getDeploymentContextDefaults()`: platform-managed
 * assistants (IS_PLATFORM) embed via the managed gemini backend unless the
 * provider leaf is explicitly set on disk. Kept local so this module does not
 * import the host loader (whose partial test mocks would otherwise break the
 * import); the parity test compares against the real loader under
 * IS_PLATFORM, so a divergent fill fails loudly there.
 */
function applyDeploymentContextFill(
  memory: MemoryConfig,
  raw: Record<string, unknown>,
): void {
  if (process.env.IS_PLATFORM !== "true" && process.env.IS_PLATFORM !== "1") {
    return;
  }
  const rawEmbeddings = raw.embeddings;
  const explicitProvider =
    rawEmbeddings !== null &&
    typeof rawEmbeddings === "object" &&
    !Array.isArray(rawEmbeddings) &&
    (rawEmbeddings as Record<string, unknown>).provider !== undefined;
  if (!explicitProvider) {
    memory.embeddings.provider = "gemini";
  }
}

/**
 * The `memory` slice of the workspace config, resolved by the plugin itself:
 * reads workspace/config.json's `memory` field directly (signature-cached),
 * applies schema defaults with the host loader's per-field invalid fallback,
 * and layers the deployment-context fill for leaves absent on disk.
 *
 * Resolution agrees with the host loader's `getConfig().memory` —
 * `memory-config-file-parity.test.ts` locks the two together. Unlike
 * `getConfig()`, this never creates directories or seeds a config file.
 */
export function getMemoryConfig(): MemoryConfig {
  const path = getWorkspaceConfigPath();
  const signature = configFileSignature(path);
  if (cached && cachedSignature === signature) {
    return cached;
  }

  const raw = readRawMemoryField(path);
  const memory = parseMemorySlice(raw);
  applyDeploymentContextFill(memory, raw);

  cached = memory;
  cachedSignature = signature;
  return memory;
}
