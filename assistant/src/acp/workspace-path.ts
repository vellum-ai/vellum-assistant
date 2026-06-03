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

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceDir } from "../util/platform.js";

/**
 * Derive a collision-resistant single path segment from a conversation id.
 *
 * Conversation ids are normally UUIDs, but the HTTP ACP spawn route accepts
 * `conversationId` as an arbitrary string and uses the resulting directory as
 * the durable cwd. A naive "replace disallowed chars + truncate" scheme is
 * NOT injective: distinct ids can map to the same segment (e.g. `foo/bar` and
 * `foo_bar` both sanitize to `foo_bar`, and two long ids sharing the first
 * 128 chars truncate to the same prefix). That would let malformed/external
 * callers accidentally SHARE an ACP workspace and see/overwrite another
 * session's repo.
 *
 * To guarantee uniqueness while staying debuggable we combine:
 *   - a short, human-readable sanitized prefix of the original id, and
 *   - a hex slice of a sha256 hash of the FULL original id.
 * The hash makes the segment unique per distinct id (same id → same segment,
 * so resolution stays deterministic), and we never let it escape its parent:
 * the prefix is sanitized to `[A-Za-z0-9._-]` and capped, and the appended
 * hash is pure hex, so the result is always a single safe path segment that
 * can never equal "", ".", or "..".
 */
function sanitizeProjectKey(conversationId: string): string {
  // Hex sha256 of the full id — uniquely identifies the conversation and is
  // itself a safe path-segment fragment (lowercase hex only).
  const hash = createHash("sha256")
    .update(conversationId, "utf8")
    .digest("hex")
    .slice(0, 16);

  // Short readable prefix for debuggability. Replace anything outside
  // `[A-Za-z0-9._-]` with `_` and cap the length so the segment stays well
  // within filesystem limits; the hash below guarantees uniqueness regardless.
  const prefix = conversationId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);

  // Drop a prefix that would otherwise produce a leading-dot-only or empty
  // segment; the hash alone is a valid, unique, safe segment.
  const safePrefix = prefix === "" || prefix === "." || prefix === ".." ? "" : prefix;

  return safePrefix === "" ? hash : `${safePrefix}-${hash}`;
}

/**
 * Resolve the stable per-project workspace directory for an ACP session,
 * creating it (recursively) if it doesn't yet exist.
 *
 * The returned path is deterministic for a given conversation id and lives
 * under the persistent workspace volume, so repeated spawns for the same
 * conversation reuse the same on-disk workspace across turns, respawns, and
 * idle-sleep/wake. The directory segment is keyed by a sha256 of the FULL id
 * (with a readable prefix) so distinct conversation ids never collide onto a
 * shared workspace.
 */
export function resolveAcpWorkspaceDir(conversationId: string): string {
  // Per-project workspaces live under `<workspaceDir>/acp` on the volume.
  const dir = join(getWorkspaceDir(), "acp", sanitizeProjectKey(conversationId));
  // `recursive: true` is idempotent — no existence pre-check (avoids TOCTOU).
  mkdirSync(dir, { recursive: true });
  return dir;
}
