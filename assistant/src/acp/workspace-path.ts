/**
 * Stable per-project workspace resolution for ACP sessions.
 *
 * An ACP session's `cwd` must be a DURABLE directory so cloned repos and
 * edits survive across turns, agent respawns, and idle-sleep/wake. The two
 * spawn paths (`runtime/routes/acp-routes.ts` and `tools/acp/spawn.ts`)
 * previously defaulted `cwd` to `process.cwd()` / `context.workingDir`,
 * which can be an ephemeral temp or vary between daemon restarts — anything
 * the agent wrote would be lost on the next turn.
 *
 * The pod's persistent workspace volume (the PVC in containerized
 * deployments, `~/.vellum/workspace` on bare metal) already survives those
 * transitions, so we pin the default `cwd` to a per-project subdirectory
 * underneath it, keyed by the parent conversation id. A follow-up spawn for
 * the same conversation deterministically resolves to the same directory and
 * lands in the same workspace the previous turn left behind.
 *
 * For isolated/risky work the caller can still pass an explicit `cwd` (e.g. a
 * git worktree); see the ACP SKILL.md "Working directory" section. This
 * helper only governs the *default*.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceDir } from "../util/platform.js";

/**
 * Sanitize a conversation id into a single safe path segment.
 *
 * Conversation ids are normally UUIDs, but we don't want a hostile or
 * unusual id to escape the ACP workspace root (e.g. via `..` or a slash) or
 * collide with sibling state. Replace anything outside `[A-Za-z0-9._-]` with
 * `_`, collapse a leading-dot-only result, and cap the length so the path
 * stays well within filesystem limits.
 */
function sanitizeProjectKey(conversationId: string): string {
  const cleaned = conversationId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  // Guard against "", ".", ".." after sanitization.
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return "_";
  }
  return cleaned;
}

/**
 * Resolve the stable per-project workspace directory for an ACP session,
 * creating it (recursively) if it doesn't yet exist.
 *
 * The returned path is deterministic for a given conversation id and lives
 * under the persistent workspace volume, so repeated spawns for the same
 * conversation reuse the same on-disk workspace across turns, respawns, and
 * idle-sleep/wake.
 */
export function resolveAcpWorkspaceDir(conversationId: string): string {
  // Per-project workspaces live under `<workspaceDir>/acp` on the volume.
  const dir = join(getWorkspaceDir(), "acp", sanitizeProjectKey(conversationId));
  // `recursive: true` is idempotent — no existence pre-check (avoids TOCTOU).
  mkdirSync(dir, { recursive: true });
  return dir;
}
