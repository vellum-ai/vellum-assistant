/**
 * Memory v3 — bundled lane system prompts + override resolution.
 *
 * The three v3 retrieval-loop lanes that make an LLM judgment call each carry a
 * system prompt:
 *
 *   - the dense-hit filter (`filter.ts`),
 *   - the tree-walk descent driver (`tree-walk.ts`),
 *   - the selection gate (`gate.ts`).
 *
 * The bundled bodies live here (under `prompts/`) so they are reviewable on
 * their own, mirroring the convention established by the v2 router prompt
 * (`../../v2/prompts/router.ts`). Operators may override any of the three at
 * runtime via `memory.v3.prompts.<lane>` so the prompts can be iterated without
 * a rebuild/restart — the same fast-iteration affordance the v2 router prompt
 * already has.
 *
 * Each lane's config entry carries two seams, resolved highest-precedence
 * first by {@link resolveV3SystemPrompt}:
 *   1. `override` — an inline prompt string (takes precedence over the path).
 *   2. `path` — a file whose contents replace the bundled body. Absolute paths
 *      are used as-is, a leading `~/` expands to the home directory, otherwise
 *      the path resolves under the workspace root.
 *
 * Failure handling is intentionally permissive: a missing file, read error,
 * oversized file, or empty/whitespace-only body all log a warning and fall back
 * to the bundled prompt. Retrieval must never break because of a bad override.
 */

import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { getLogger } from "../../../util/logger.js";

const log = getLogger("memory-v3-prompts");

/**
 * Hard upper bound on an override (inline or file). The bundled prompts are
 * well under 4 KiB; 1 MiB is generous for any reasonable hand-edit while still
 * preventing pathological inputs from being slurped into memory on every lane
 * call. Matches the v2 router prompt's guard.
 */
const MAX_PROMPT_BYTES = 1 * 1024 * 1024;

/**
 * Bundled system prompt for the fast dense-hit filter (`filter.ts`). Keeps the
 * meaningful embedding-similarity associations and drops spurious
 * near-neighbors before the more expensive selection gate runs.
 */
export const FILTER_SYSTEM_PROMPT =
  "You are a fast relevance filter for a memory-retrieval loop. You are given " +
  "candidate concept pages surfaced by embedding similarity for the current " +
  "turn. Keep the pages that are meaningful associations and drop the " +
  "spurious near-neighbors. When in doubt, keep.";

/**
 * Bundled system prompt for the tree-walk descent driver (`tree-walk.ts`).
 * Decides which child nodes of the current memory-tree node to descend into.
 */
export const DESCENT_SYSTEM_PROMPT =
  "You are the descent driver for a hierarchical memory-retrieval walk. At each " +
  "node you see its child index (one line per child sub-node or leaf page) and " +
  "the current conversation turn. Choose which child *nodes* to descend into to " +
  "find the pages that bear on the next reply. Leaf pages are collected " +
  "automatically — you only decide which branches to explore deeper.";

/**
 * Bundled system prompt for the selection gate (`gate.ts`). Decides whether the
 * accumulated candidate pages are sufficient to answer the next reply.
 */
export const GATE_SYSTEM_PROMPT =
  "You are the final selection gate for a memory-retrieval loop. You are " +
  "given the candidate concept pages gathered so far for the current turn. " +
  "Decide whether they are sufficient to answer the next reply. Lean toward " +
  "recall: keep a candidate whenever it plausibly bears on the turn rather " +
  "than dropping it. When the turn asks for a list, for 'all of' something, " +
  "or for a broad answer, select every candidate that plausibly belongs — " +
  "do not trim to only the most prominent ones. Drop a candidate only when it " +
  "is clearly irrelevant to the turn.";

/**
 * One lane's prompt-override config: an optional inline `override` string and
 * an optional file `path`. Both default to `null`. Mirrors the v2 router
 * prompt's `router_prompt_path` (file) plus inline-override seam, generalized
 * to the three v3 lanes.
 */
export interface V3PromptOverrideConfig {
  override: string | null;
  path: string | null;
}

/**
 * Resolve a v3 lane's system prompt, applying the configured override (inline
 * first, then file path) and falling back to `bundled` when neither produces a
 * usable body. Unlike the v2 router prompt these bodies carry no placeholders,
 * so the resolved contents are returned verbatim.
 *
 * @param bundled  The lane's bundled default body (the fallback).
 * @param config   The lane's `memory.v3.prompts.<lane>` config, if present.
 * @param workspaceDir  Workspace root used to resolve a relative file `path`.
 */
export function resolveV3SystemPrompt(
  bundled: string,
  config: V3PromptOverrideConfig | undefined,
  workspaceDir: string,
): string {
  // Inline override wins over the file path and the bundled body. An
  // empty/whitespace-only string is treated as "no override" so a cleared
  // config value falls through to the path/bundled resolution.
  const inline = config?.override ?? null;
  if (inline !== null) {
    if (inline.length > MAX_PROMPT_BYTES) {
      log.warn(
        {
          size: inline.length,
          limit: MAX_PROMPT_BYTES,
          reason: "oversized_inline_override",
          fallback: "path_or_bundled",
        },
        "v3 system-prompt inline override exceeds size limit; falling back",
      );
    } else if (inline.trim().length > 0) {
      return inline;
    }
  }

  const path = config?.path ?? null;
  if (path === null) return bundled;

  const resolvedPath = resolveOverridePath(path, workspaceDir);
  let contents: string;
  try {
    const stat = lstatSync(resolvedPath);
    if (!stat.isFile()) {
      log.warn(
        {
          configuredPath: path,
          resolvedPath,
          reason: "not_regular_file",
          fallback: "bundled",
        },
        "v3 system-prompt override is not a regular file; using bundled prompt",
      );
      return bundled;
    }
    if (stat.size > MAX_PROMPT_BYTES) {
      log.warn(
        {
          configuredPath: path,
          resolvedPath,
          size: stat.size,
          limit: MAX_PROMPT_BYTES,
          reason: "oversized_override",
          fallback: "bundled",
        },
        "v3 system-prompt override exceeds size limit; using bundled prompt",
      );
      return bundled;
    }
    contents = readFileSync(resolvedPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    log.warn(
      { configuredPath: path, resolvedPath, code, fallback: "bundled" },
      "v3 system-prompt override unreadable; using bundled prompt",
    );
    return bundled;
  }

  if (contents.trim().length === 0) {
    log.warn(
      {
        configuredPath: path,
        resolvedPath,
        reason: "empty_override",
        fallback: "bundled",
      },
      "v3 system-prompt override is empty; using bundled prompt",
    );
    return bundled;
  }

  return contents;
}

function resolveOverridePath(
  overridePath: string,
  workspaceDir: string,
): string {
  if (overridePath.startsWith("~/")) {
    return join(homedir(), overridePath.slice(2));
  }
  if (isAbsolute(overridePath)) return overridePath;
  return join(workspaceDir, overridePath);
}
