/**
 * Caching layer for the LLM-generated personalized home greeting.
 *
 * The greeting (a short persona-flavored "here's what's been going on" line)
 * is generated via `runBtwSidechain` and displayed at the top of the Home
 * page. To avoid redundant LLM calls on every feed fetch, we cache the
 * result for 4 hours with content-hash-based invalidation: when IDENTITY.md,
 * SOUL.md, or the guardian persona change, the cache is busted.
 *
 * Storage uses the existing `memory_checkpoints` table (simple key-value store).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../persistence/checkpoints.js";
import { resolveGuardianPersona } from "../prompts/persona-resolver.js";
import { getWorkspacePromptPath } from "../util/platform.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const CHECKPOINT_KEY_TEXT = "home:greeting:text";
const CHECKPOINT_KEY_HASH = "home:greeting:content_hash";
const CHECKPOINT_KEY_TIMESTAMP = "home:greeting:cached_at";

const IDENTITY_FILES = ["IDENTITY.md", "SOUL.md"] as const;

function readWorkspaceFile(name: string): string {
  try {
    const path = getWorkspacePromptPath(name);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function computeIdentityContentHash(): string {
  const staticFiles = IDENTITY_FILES.map(readWorkspaceFile).join("\n---\n");
  const guardianPersona = resolveGuardianPersona() ?? "";
  const combined = staticFiles + "\n---\n" + guardianPersona;
  return createHash("sha256").update(combined).digest("hex");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getCachedHomeGreeting(): string | null {
  try {
    const text = getMemoryCheckpoint(CHECKPOINT_KEY_TEXT);
    const hash = getMemoryCheckpoint(CHECKPOINT_KEY_HASH);
    const timestampStr = getMemoryCheckpoint(CHECKPOINT_KEY_TIMESTAMP);

    if (!text || !hash || !timestampStr) {
      return null;
    }

    const cachedAt = Number(timestampStr);
    if (isNaN(cachedAt) || Date.now() - cachedAt > CACHE_TTL_MS) {
      return null;
    }

    const currentHash = computeIdentityContentHash();
    if (currentHash !== hash) {
      return null;
    }

    return text;
  } catch {
    return null;
  }
}

/**
 * Persist a freshly generated greeting. Returns `true` when the cache
 * write landed; `false` on failure so callers don't report fresh content
 * that the next read cannot serve.
 */
export function setCachedHomeGreeting(text: string): boolean {
  try {
    const hash = computeIdentityContentHash();
    const now = String(Date.now());
    setMemoryCheckpoint(CHECKPOINT_KEY_TEXT, text);
    setMemoryCheckpoint(CHECKPOINT_KEY_HASH, hash);
    setMemoryCheckpoint(CHECKPOINT_KEY_TIMESTAMP, now);
    return true;
  } catch {
    // Cache write failure is non-fatal — next request will regenerate.
    return false;
  }
}
