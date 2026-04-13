/**
 * Relationship-state writer.
 *
 * Derives a `RelationshipState` snapshot from the filesystem state of
 * the workspace (the guardian's `users/<slug>.md` persona file — resolved
 * via `persona-resolver` / `contact-store` — for world + priorities facts,
 * with legacy workspace-root `USER.md` as a last-ditch fallback; SOUL.md
 * for voice facts; IDENTITY.md for assistant / hatched metadata; the
 * conversations directory for conversationCount) plus the OAuth
 * connection store (for capability tiers), and writes it to
 * `<workspace>/data/relationship-state.json`.
 *
 * Per assistant/CLAUDE.md the daemon must never block or throw at
 * startup — the public entry points here catch every error and log a
 * warning instead. Internal helpers use a narrow `safeRead` wrapper so
 * a missing or unreadable file degrades gracefully to an empty string.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { listConnections } from "../oauth/oauth-store.js";
import { resolveGuardianPersonaPath } from "../prompts/persona-resolver.js";
import { getLogger } from "../util/logger.js";
import {
  getConversationsDir,
  getDataDir,
  getWorkspacePromptPath,
} from "../util/platform.js";
import { computeProgressPercent, computeTier } from "./progress-formula.js";
import {
  type Capability,
  DEFAULT_CAPABILITIES,
  type Fact,
  RELATIONSHIP_STATE_VERSION,
  type RelationshipState,
} from "./relationship-state.js";

const log = getLogger("relationship-state-writer");

/**
 * Filename for the on-disk snapshot. Lives under the workspace data dir.
 */
export const RELATIONSHIP_STATE_FILENAME = "relationship-state.json";

/**
 * Conversation-count threshold at which the "voice-writing" capability
 * flips from `earned` (gated, shown with an `unlockHint`) to `unlocked`.
 *
 * This is a placeholder for Open Question #6 in the TDD. Wrap as a
 * named constant so it's obvious which knob to tune when a deeper
 * heuristic replaces it.
 */
const VOICE_WRITING_UNLOCK_CONVERSATIONS = 10;

/** Default assistant name when IDENTITY.md cannot be parsed. */
const DEFAULT_ASSISTANT_NAME = "Vellum";

/** Default assistant identifier (multi-assistant reserved for future). */
const DEFAULT_ASSISTANT_ID = "default";

/**
 * Canonical path to the relationship-state snapshot
 * (`<workspace>/data/relationship-state.json`).
 */
export function getRelationshipStatePath(): string {
  return join(getDataDir(), RELATIONSHIP_STATE_FILENAME);
}

/**
 * Build a fresh `RelationshipState` from the current on-disk + DB state.
 *
 * This is the pure-ish computation half of the writer — it reads files
 * and the oauth store but performs no writes. Callers that want to
 * persist the result should use `writeRelationshipState()` instead.
 */
export async function computeRelationshipState(): Promise<RelationshipState> {
  // Persona source-of-truth:
  //   1. The guardian contact's per-user file (`users/<slug>.md`), resolved
  //      via `resolveGuardianPersonaPath()` — this is the canonical location
  //      after workspace migration 031 and handles slugged userFiles like
  //      `users/sidd.md` that were invisible to a hardcoded `default.md`
  //      lookup.
  //   2. Legacy workspace-root `USER.md` as a last-ditch fallback for very
  //      old workspaces that never ran migration 031.
  //   3. Empty string → extraction yields [] and `userName` is undefined.
  // Every step is guarded because the writer must never throw.
  const userMd = resolveGuardianUserContent();
  const soulMd = safeRead(getWorkspacePromptPath("SOUL.md"));
  const identityPath = getWorkspacePromptPath("IDENTITY.md");

  const facts = extractFacts({
    userContent: userMd,
    soulContent: soulMd,
  });
  const conversationCount = countConversations();
  const capabilities = resolveCapabilityTiers({ conversationCount });
  const { assistantName, hatchedDate } = parseIdentity(identityPath);
  const userName = parseUserName(userMd);

  const tier = computeTier({ facts, capabilities, conversationCount });
  const progressPercent = computeProgressPercent({
    facts,
    capabilities,
    conversationCount,
  });

  return {
    version: RELATIONSHIP_STATE_VERSION,
    assistantId: DEFAULT_ASSISTANT_ID,
    tier,
    progressPercent,
    facts,
    capabilities,
    conversationCount,
    hatchedDate,
    assistantName,
    userName,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Compute a fresh snapshot and persist it to `getRelationshipStatePath()`.
 *
 * Never throws — all errors are caught and logged as warnings. Fire-and-
 * forget callers (e.g. the conversation-complete hook) can safely call
 * this without additional try/catch wrapping.
 */
export async function writeRelationshipState(): Promise<void> {
  try {
    const state = await computeRelationshipState();
    const path = getRelationshipStatePath();
    mkdirSync(getDataDir(), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
    log.info(
      {
        path,
        tier: state.tier,
        progress: state.progressPercent,
        facts: state.facts.length,
      },
      "Wrote relationship-state.json",
    );
  } catch (err) {
    log.warn({ err }, "Failed to write relationship-state.json");
  }
}

/**
 * One-time backfill for existing / upgraded users.
 *
 * On daemon startup we want existing users to land on a populated
 * `relationship-state.json` instead of an empty Home page. This helper
 * is idempotent: it only writes when the file is missing, so subsequent
 * boots are a cheap `existsSync` check and nothing else. The regular
 * conversation-complete writer path keeps the snapshot fresh after the
 * first write, so there is no need to re-run the backfill.
 *
 * Callers must treat this as fire-and-forget: per `assistant/CLAUDE.md`
 * the daemon must never block startup, so `writeRelationshipState()`
 * already catches every error. Wrapping this call in
 * `void backfillRelationshipStateIfMissing().catch(() => {})` at the
 * startup site provides a second belt-and-suspenders guarantee for any
 * unexpected throw out of `existsSync`.
 */
export async function backfillRelationshipStateIfMissing(): Promise<void> {
  const path = getRelationshipStatePath();
  if (existsSync(path)) return; // idempotent — only runs once
  log.info("Backfilling relationship-state.json for existing or upgraded user");
  await writeRelationshipState();
}

// ─── Internal helpers ───────────────────────────────────────────────────

/**
 * Resolve the raw markdown content of the guardian's user persona file
 * (`users/<slug>.md`), falling back to legacy workspace-root `USER.md`
 * when no guardian is resolvable or the persona file is missing.
 *
 * Uses `resolveGuardianPersonaPath()` rather than a hardcoded
 * `users/default.md` so slugged user files populated by
 * `generateUserFileSlug` (e.g. `users/sidd.md`) are read correctly —
 * otherwise the writer would systematically under-extract facts and
 * `userName` for any contact-aware workspace.
 *
 * Every step is guarded: any exception from the persona resolver or
 * the underlying contact store DB lookup collapses to the empty string
 * via the normal fallback chain, so `computeRelationshipState()` never
 * throws from this path.
 */
function resolveGuardianUserContent(): string {
  try {
    const guardianPath = resolveGuardianPersonaPath();
    if (guardianPath) {
      const content = safeRead(guardianPath);
      if (content) return content;
    }
  } catch (err) {
    log.warn(
      { err },
      "Failed to resolve guardian persona path; falling back to legacy USER.md",
    );
  }

  // Legacy fallback: workspace-root USER.md for very old workspaces
  // that predate migration 031.
  const legacyPath = getWorkspacePromptPath("USER.md");
  const legacy = safeRead(legacyPath);
  if (legacy) return legacy;

  return "";
}

/**
 * Read a file as UTF-8, returning "" on any error.
 *
 * Used for every disk read in this module so a missing or unreadable
 * workspace file degrades gracefully to an empty content string rather
 * than propagating an exception out of a startup path.
 */
function safeRead(path: string): string {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Walk the workspace prompt files and emit a flat list of inferred
 * facts. This is deliberately a simple bullet/heading parser — the TDD
 * explicitly calls out "don't try to be clever" here; the goal is to
 * produce something non-empty for the UI so progress looks alive.
 *
 * Voice facts come from SOUL.md. World and priorities facts come from
 * the guardian's `users/<slug>.md` persona file (resolved via
 * `persona-resolver`), with legacy workspace-root `USER.md` as a
 * fallback for workspaces that predate migration 031.
 */
function extractFacts(input: {
  userContent: string;
  soulContent: string;
}): Fact[] {
  const facts: Fact[] = [];
  let counter = 0;
  const nextId = (prefix: string): string => {
    counter += 1;
    return `${prefix}-${counter}`;
  };

  // Heuristic keyword map for USER.md sections -> fact category. Keys
  // are matched case-insensitively as a prefix of the heading/bullet
  // label. Everything that doesn't match stays a "world" fact.
  const priorityKeywords = [
    "goals",
    "priority",
    "priorities",
    "focus",
    "work role",
    "role",
    "projects",
    "daily tools",
    "tools",
  ];
  const worldKeywords = [
    "name",
    "pronouns",
    "locale",
    "location",
    "hobbies",
    "fun",
    "timezone",
    "background",
  ];

  for (const line of iterateBulletLines(input.userContent)) {
    const parsed = parseBulletLabelValue(line);
    if (!parsed) continue;
    const { label, value } = parsed;
    if (!value) continue;
    const lower = label.toLowerCase();
    const isPriority = priorityKeywords.some((k) => lower.startsWith(k));
    const isWorld = worldKeywords.some((k) => lower.startsWith(k));
    const category: Fact["category"] = isPriority
      ? "priorities"
      : isWorld
        ? "world"
        : "world";
    facts.push({
      id: nextId("user"),
      category,
      text: `${capitalizeLabel(label)}: ${value}`,
      confidence: "strong",
      source: "inferred",
    });
  }

  for (const line of iterateBulletLines(input.soulContent)) {
    const parsed = parseBulletLabelValue(line);
    if (!parsed) continue;
    const { label, value } = parsed;
    if (!value) continue;
    facts.push({
      id: nextId("soul"),
      category: "voice",
      text: `${capitalizeLabel(label)}: ${value}`,
      confidence: "strong",
      source: "inferred",
    });
  }

  return facts;
}

/**
 * Yield non-empty bullet lines from a markdown string, skipping comment
 * lines (leading `_`) and indented continuation. Lines returned are the
 * trimmed bullet body, without the leading `-` or `*`.
 */
function* iterateBulletLines(content: string): Generator<string> {
  if (!content) return;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("_")) continue;
    if (!line.startsWith("- ") && !line.startsWith("* ")) continue;
    const body = line.slice(2).trim();
    if (body.length === 0) continue;
    yield body;
  }
}

/**
 * Parse a bullet body of the form `**Label:** value` or `Label: value`
 * into its label and value halves. Returns null when no colon is found.
 */
function parseBulletLabelValue(
  body: string,
): { label: string; value: string } | null {
  const stripped = body.replace(/\*\*/g, "").replace(/__/g, "");
  const idx = stripped.indexOf(":");
  if (idx <= 0) return null;
  const label = stripped.slice(0, idx).trim();
  const value = stripped.slice(idx + 1).trim();
  if (!label) return null;
  return { label, value };
}

/**
 * Lowercase-ify a label but keep the first character uppercased for
 * display: "PREFERRED Name" -> "Preferred name".
 */
function capitalizeLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

/**
 * Project `DEFAULT_CAPABILITIES` into a concrete capability list by
 * consulting the OAuth connection store for integration-gated tiers
 * and the conversation count for usage-gated tiers.
 *
 * Failures in the oauth lookup fall back to the "empty set" — every
 * integration appears as `next-up` — so startup paths never throw.
 */
function resolveCapabilityTiers(opts: {
  conversationCount: number;
}): Capability[] {
  const connectedProviders = resolveConnectedProviders();

  return DEFAULT_CAPABILITIES.map((cap) => {
    switch (cap.id) {
      case "email": {
        // Only Gmail is a real email integration today. Outlook appears in
        // seed-providers.ts as scaffolding but we don't actually ship a
        // Microsoft integration, so we do not advertise email unlock for it.
        const unlocked =
          connectedProviders.has("google") || connectedProviders.has("gmail");
        return { ...cap, tier: unlocked ? "unlocked" : "next-up" };
      }
      case "calendar": {
        // Only Google Calendar is a real calendar integration today.
        const unlocked =
          connectedProviders.has("google") ||
          connectedProviders.has("google-calendar");
        return { ...cap, tier: unlocked ? "unlocked" : "next-up" };
      }
      case "slack": {
        const unlocked = connectedProviders.has("slack");
        return { ...cap, tier: unlocked ? "unlocked" : "next-up" };
      }
      case "voice-writing": {
        const unlocked =
          opts.conversationCount >= VOICE_WRITING_UNLOCK_CONVERSATIONS;
        return { ...cap, tier: unlocked ? "unlocked" : "earned" };
      }
      case "proactive":
      case "autonomous":
      default:
        return { ...cap, tier: "earned" };
    }
  });
}

/**
 * Return the set of provider keys with at least one `active` OAuth
 * connection. Any failure (DB not initialized, schema drift, etc.)
 * returns an empty set so the writer keeps advancing with sane
 * defaults.
 */
function resolveConnectedProviders(): Set<string> {
  try {
    const rows = listConnections();
    const set = new Set<string>();
    for (const row of rows) {
      if (row.status === "active") set.add(row.provider);
    }
    return set;
  } catch (err) {
    log.warn(
      { err },
      "Failed to list OAuth connections; assuming no integrations connected",
    );
    return new Set<string>();
  }
}

/**
 * Count conversations by listing the conversations directory. Returns
 * 0 when the directory is missing or unreadable.
 */
function countConversations(): number {
  try {
    const dir = getConversationsDir();
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * Pull `assistantName` and `hatchedDate` from IDENTITY.md.
 *
 * IDENTITY.md is a freeform markdown file, so for the name we scan
 * bullet lines for the first recognizable `name` label. For the
 * hatched date we prefer any explicit `hatched:` / `birth:` bullet,
 * then fall back to the file's `stat.birthtime` (matching the
 * pattern already established by `identity-routes.ts`), and finally
 * to `stat.mtime` if birthtime is unavailable. We never fall back to
 * `new Date()` — `writeRelationshipState()` is called on every turn
 * boundary, so a `Date.now()` fallback would cause `hatchedDate` to
 * drift forward on every write, turning a stable "relationship
 * start" timestamp into a constantly-updating "last touched"
 * timestamp. When nothing is readable we emit the Unix epoch as an
 * unmistakable sentinel instead of silently drifting.
 */
function parseIdentity(identityPath: string): {
  assistantName: string;
  hatchedDate: string;
} {
  const content = safeRead(identityPath);

  let assistantName = DEFAULT_ASSISTANT_NAME;
  let explicitHatched: string | undefined;

  for (const line of iterateBulletLines(content)) {
    const parsed = parseBulletLabelValue(line);
    if (!parsed || !parsed.value) continue;
    const lower = parsed.label.toLowerCase();
    if (lower.startsWith("name") && assistantName === DEFAULT_ASSISTANT_NAME) {
      assistantName = parsed.value;
    }
    if (
      !explicitHatched &&
      (lower.startsWith("hatched") || lower.startsWith("birth"))
    ) {
      const parsedDate = new Date(parsed.value);
      if (!isNaN(parsedDate.getTime())) {
        explicitHatched = parsedDate.toISOString();
      }
    }
  }

  if (explicitHatched) {
    return { assistantName, hatchedDate: explicitHatched };
  }

  // Stable fallback: use the IDENTITY.md file birth time so the
  // relationship start date is monotonic across turns. Matches the
  // approach used by `identity-routes.ts` for the Settings UI.
  try {
    const stats = statSync(identityPath);
    const candidate =
      stats.birthtime.getTime() > 0 ? stats.birthtime : stats.mtime;
    if (candidate.getTime() > 0) {
      return { assistantName, hatchedDate: candidate.toISOString() };
    }
  } catch {
    // File missing or unreadable — fall through to the sentinel.
  }

  // Last-ditch sentinel: unmistakably ancient so any UI showing it
  // makes the "we couldn't resolve your hatched date" state obvious.
  return { assistantName, hatchedDate: new Date(0).toISOString() };
}

/**
 * Best-effort user-name extraction from USER.md (or its successor
 * `users/<slug>.md`). Returns undefined when no `name`/`preferred` line
 * is present so the caller can leave `userName` off the wire.
 */
function parseUserName(content: string): string | undefined {
  if (!content) return undefined;
  for (const line of iterateBulletLines(content)) {
    const parsed = parseBulletLabelValue(line);
    if (!parsed) continue;
    const lower = parsed.label.toLowerCase();
    if (
      (lower.startsWith("name") ||
        lower.startsWith("preferred") ||
        lower === "user" ||
        lower === "user name") &&
      parsed.value
    ) {
      return parsed.value;
    }
  }
  return undefined;
}
