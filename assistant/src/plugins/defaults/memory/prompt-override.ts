/**
 * Shared loader for file-based prompt overrides.
 *
 * The memory router, consolidation, v3 selector, and retrospective prompts each
 * ship a bundled default that operators may replace by pointing a config field
 * at a file. The load-with-fallback semantics are identical across all of them,
 * so they live here: path resolution, workspace containment, the size guard,
 * and the permissive fallback that keeps retrieval/consolidation working when
 * an override is missing or malformed.
 *
 * Containment is a security boundary, not a convenience. The override fields
 * are writable by any `settings.write` principal, and the loaded contents reach
 * the LLM provider — and, for the retrospective prompt, are persisted onto a
 * fork conversation readable with `chat.read`. Confining overrides to the
 * workspace root (which by policy holds no secrets) keeps the loader from
 * doubling as an arbitrary-file-read primitive for daemon-readable files such
 * as SSH keys or token stores.
 *
 * The caller owns the bundled default and any placeholder substitution — this
 * module only decides whether a usable override file exists and returns its raw
 * contents, or `null` to mean "fall back to the bundled prompt."
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { isPathInsideRoot } from "./path-containment.js";

/**
 * Minimal logger surface the loader needs. Structurally compatible with
 * `pino.Logger`, so callers pass their module logger directly and the warnings
 * keep that logger's namespace; tests pass a lightweight recorder.
 */
export interface PromptOverrideLogger {
  warn(obj: object, msg: string): void;
}

/**
 * Hard upper bound on an override file. The bundled prompts are kilobytes; 1 MiB
 * is generous headroom for a hand-edit while preventing a `settings.write`
 * principal from pointing the field at a giant file (or an unsizeable stream
 * `lstat` can't cap on its own) and slurping it into memory on every call.
 */
export const MAX_PROMPT_OVERRIDE_BYTES = 1 * 1024 * 1024;

/**
 * Resolve a configured override path to an absolute path: a leading `~/` expands
 * to the home directory, an absolute path is used as-is, and a relative path
 * resolves under `workspaceDir`. Resolution alone grants no read access —
 * {@link loadPromptOverride} additionally requires the resolved real path to
 * stay inside `workspaceDir`.
 */
export function resolveOverridePath(
  overridePath: string,
  workspaceDir: string,
): string {
  if (overridePath.startsWith("~/")) {
    return join(homedir(), overridePath.slice(2));
  }
  if (isAbsolute(overridePath)) return overridePath;
  return join(workspaceDir, overridePath);
}

/**
 * Load a prompt-override file, returning its raw contents when the override is
 * present and usable, or `null` (after logging a warning describing why) when
 * the caller should fall back to its bundled prompt. A nullish `overridePath`
 * (`null` or `undefined`) returns `null` without touching the filesystem.
 *
 * The override must live inside `workspaceDir`: the configured path is
 * resolved, then its real path (symlinks followed) is required to stay under
 * the workspace root's real path. Anything else — an absolute path elsewhere on
 * disk, a `~/` path outside the workspace, a `..` escape, or a symlinked
 * directory pointing out — is rejected with an `outside_workspace` warning, so
 * a settings-writable field can never read files the workspace doesn't own.
 *
 * Fallback is intentionally total — an absent override, a missing,
 * out-of-workspace, non-regular, oversized, unreadable, or empty/whitespace-only
 * file all degrade to `null`. Memory retrieval and consolidation must never
 * break because of a bad override, so `undefined` (an unset config field) is
 * treated as "no override" rather than crashing on path resolution.
 *
 * `label` names the prompt in the warning messages (e.g. `"router prompt"`).
 */
export function loadPromptOverride(opts: {
  overridePath: string | null | undefined;
  workspaceDir: string;
  log: PromptOverrideLogger;
  label: string;
}): string | null {
  const { overridePath, workspaceDir, log, label } = opts;
  if (overridePath == null) return null;

  const resolvedPath = resolveOverridePath(overridePath, workspaceDir);
  let contents: string;
  try {
    const realWorkspaceDir = realpathSync(workspaceDir);
    const realResolvedPath = realpathSync(resolvedPath);
    if (!isPathInsideRoot(realResolvedPath, realWorkspaceDir)) {
      log.warn(
        {
          configuredPath: overridePath,
          resolvedPath,
          realPath: realResolvedPath,
          workspaceDir: realWorkspaceDir,
          reason: "outside_workspace",
          fallback: "bundled",
        },
        `${label} override resolves outside the workspace root; using bundled prompt`,
      );
      return null;
    }
    // lstat the unresolved path so a symlink final component stays rejected
    // even when its target is a regular file inside the workspace.
    const stat = lstatSync(resolvedPath);
    if (!stat.isFile()) {
      log.warn(
        {
          configuredPath: overridePath,
          resolvedPath,
          reason: "not_regular_file",
          fallback: "bundled",
        },
        `${label} override is not a regular file; using bundled prompt`,
      );
      return null;
    }
    if (stat.size > MAX_PROMPT_OVERRIDE_BYTES) {
      log.warn(
        {
          configuredPath: overridePath,
          resolvedPath,
          size: stat.size,
          limit: MAX_PROMPT_OVERRIDE_BYTES,
          reason: "oversized_override",
          fallback: "bundled",
        },
        `${label} override exceeds size limit; using bundled prompt`,
      );
      return null;
    }
    contents = readFileSync(realResolvedPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    log.warn(
      { configuredPath: overridePath, resolvedPath, code, fallback: "bundled" },
      `${label} override unreadable; using bundled prompt`,
    );
    return null;
  }

  if (contents.trim().length === 0) {
    log.warn(
      {
        configuredPath: overridePath,
        resolvedPath,
        reason: "empty_override",
        fallback: "bundled",
      },
      `${label} override is empty; using bundled prompt`,
    );
    return null;
  }

  return contents;
}
