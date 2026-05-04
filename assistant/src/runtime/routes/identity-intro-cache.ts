/**
 * Caching layer for the LLM-generated identity intro text.
 *
 * The intro (a short identity tagline) is generated via the
 * /v1/btw endpoint and displayed on the Identity panel. To avoid redundant LLM
 * calls, we cache the result for 4 hours with content-hash-based invalidation:
 * when IDENTITY.md, SOUL.md, or the guardian's per-user persona file change,
 * the cache is busted.
 *
 * Storage uses the existing `memory_checkpoints` table (simple key-value store).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../memory/checkpoints.js";
import { resolveGuardianPersona } from "../../prompts/persona-resolver.js";
import { getWorkspacePromptPath } from "../../util/platform.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const CHECKPOINT_KEY_TEXT = "identity:intro:text";
const CHECKPOINT_KEY_HASH = "identity:intro:content_hash";
const CHECKPOINT_KEY_TIMESTAMP = "identity:intro:cached_at";

/** Workspace files whose content influences the identity intro. */
const IDENTITY_FILES = ["IDENTITY.md", "SOUL.md"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a workspace prompt file, returning empty string if missing. */
function readWorkspaceFile(name: string): string {
  try {
    const path = getWorkspacePromptPath(name);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function parseIdentityIntroSection(content: string): string | null {
  let inSection = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (/^#+\s/.test(trimmed)) {
      inSection = trimmed.toLowerCase().includes("identity intro");
      continue;
    }
    if (inSection && trimmed.length > 0) {
      return trimmed;
    }
  }

  return null;
}

/**
 * Read the explicit `## Identity Intro` section from workspace prompt files.
 *
 * BOOTSTRAP.md instructs the assistant to write this section in IDENTITY.md.
 * SOUL.md remains a fallback for older workspaces that stored the intro there.
 */
export function readWorkspaceIdentityIntro(): string | null {
  return (
    parseIdentityIntroSection(readWorkspaceFile("IDENTITY.md")) ??
    parseIdentityIntroSection(readWorkspaceFile("SOUL.md"))
  );
}

/** Compute a SHA-256 hex hash of the concatenated identity file contents. */
export function computeIdentityContentHash(): string {
  const staticFiles = IDENTITY_FILES.map(readWorkspaceFile).join("\n---\n");
  const guardianPersona = resolveGuardianPersona() ?? "";
  const combined = staticFiles + "\n---\n" + guardianPersona;
  return createHash("sha256").update(combined).digest("hex");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CachedIntro {
  text: string;
}

/**
 * Retrieve the cached identity intro if it exists, is within the TTL window,
 * and the identity files have not changed since it was generated.
 *
 * Returns `null` when the cache is missing, expired, or invalidated.
 */
export function getCachedIntro(): CachedIntro | null {
  try {
    const text = getMemoryCheckpoint(CHECKPOINT_KEY_TEXT);
    const hash = getMemoryCheckpoint(CHECKPOINT_KEY_HASH);
    const timestampStr = getMemoryCheckpoint(CHECKPOINT_KEY_TIMESTAMP);

    if (!text || !hash || !timestampStr) return null;

    // TTL check
    const cachedAt = Number(timestampStr);
    if (isNaN(cachedAt) || Date.now() - cachedAt > CACHE_TTL_MS) return null;

    // Content-hash check — bust cache when identity files change
    const currentHash = computeIdentityContentHash();
    if (currentHash !== hash) return null;

    return { text };
  } catch {
    return null;
  }
}

/**
 * Store the generated identity intro text in the cache along with
 * the current content hash and timestamp.
 */
export function setCachedIntro(text: string): void {
  try {
    const hash = computeIdentityContentHash();
    const now = String(Date.now());
    setMemoryCheckpoint(CHECKPOINT_KEY_TEXT, text);
    setMemoryCheckpoint(CHECKPOINT_KEY_HASH, hash);
    setMemoryCheckpoint(CHECKPOINT_KEY_TIMESTAMP, now);
  } catch {
    // Cache write failure is non-fatal — next request will regenerate.
  }
}
