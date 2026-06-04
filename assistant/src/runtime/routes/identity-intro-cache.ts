/**
 * Caching layer for identity greetings.
 *
 * Greetings are sourced from (in priority order):
 * 1. A `## Greetings` section in SOUL.md (user-defined bullet list)
 * 2. A cached greetings array (populated by the empty-state greeting callsite)
 * 3. A generic fallback when generation is unavailable
 *
 * Cache uses TTL + content-hash invalidation: when IDENTITY.md, SOUL.md, or
 * the guardian persona change, the cache is busted.
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

const CHECKPOINT_KEY_GREETINGS = "identity:intro:greetings";
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

/**
 * Parse the `## Greetings` section from SOUL.md. Returns bullet items as an
 * array of strings, or `null` if the section is missing or empty.
 */
export function parseGreetingsSection(content: string): string[] | null {
  let inSection = false;
  let sectionLevel: number | null = null;
  const greetings: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      if (inSection) {
        if (sectionLevel !== null && level <= sectionLevel) break;
        continue;
      }
      if (level === 2 && /^greetings$/i.test(title)) {
        inSection = true;
        sectionLevel = level;
      }
      continue;
    }
    if (!inSection) continue;
    const bullet = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(trimmed);
    const greeting = bullet?.[1]?.trim();
    if (greeting) {
      greetings.push(greeting);
    }
  }

  return greetings.length > 0 ? greetings : null;
}

/**
 * Read user-defined greetings from the `## Greetings` section of SOUL.md.
 */
export function readWorkspaceGreetings(): string[] | null {
  const soulContent = readWorkspaceFile("SOUL.md");
  if (!soulContent) return null;
  return parseGreetingsSection(soulContent);
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
  greetings: string[];
}

/**
 * Retrieve the cached greetings array if it exists, is within the TTL window,
 * and the identity files have not changed since it was generated.
 *
 * Returns `null` when the cache is missing, expired, or invalidated.
 */
export function getCachedIntro(): CachedIntro | null {
  try {
    const raw = getMemoryCheckpoint(CHECKPOINT_KEY_GREETINGS);
    const hash = getMemoryCheckpoint(CHECKPOINT_KEY_HASH);
    const timestampStr = getMemoryCheckpoint(CHECKPOINT_KEY_TIMESTAMP);

    if (!raw || !hash || !timestampStr) return null;

    // TTL check
    const cachedAt = Number(timestampStr);
    if (isNaN(cachedAt) || Date.now() - cachedAt > CACHE_TTL_MS) return null;

    // Content-hash check — bust cache when identity files change
    const currentHash = computeIdentityContentHash();
    if (currentHash !== hash) return null;

    // Parse stored value — handles both JSON array and legacy single string
    let greetings: string[];
    try {
      const parsed = JSON.parse(raw);
      greetings = Array.isArray(parsed) ? parsed : [raw];
    } catch {
      greetings = [raw];
    }

    return { greetings };
  } catch {
    return null;
  }
}

/**
 * Store a greetings array in the cache along with the current content hash
 * and timestamp.
 */
export function setCachedIntro(greetings: string[]): void {
  try {
    const hash = computeIdentityContentHash();
    const now = String(Date.now());
    setMemoryCheckpoint(CHECKPOINT_KEY_GREETINGS, JSON.stringify(greetings));
    setMemoryCheckpoint(CHECKPOINT_KEY_HASH, hash);
    setMemoryCheckpoint(CHECKPOINT_KEY_TIMESTAMP, now);
  } catch {
    // Cache write failure is non-fatal — next request will regenerate.
  }
}
