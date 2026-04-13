/**
 * Relationship-state writer.
 *
 * Derives a `RelationshipState` snapshot from the filesystem state of
 * the workspace (the guardian's `users/<slug>.md` persona file — resolved
 * via `persona-resolver` / `contact-store` — for world + priorities facts,
 * with legacy workspace-root `USER.md` as a last-ditch fallback; SOUL.md
 * for voice facts; IDENTITY.md for assistant / hatched metadata) plus
 * the DB-authoritative conversation count (via
 * `conversation-queries.countConversations`, matching the UI's
 * `listConversations` filter — no `background` / `private` / `scheduled`)
 * and the OAuth connection store (for capability tiers), and writes it
 * to `<workspace>/data/relationship-state.json`.
 *
 * Per assistant/CLAUDE.md the daemon must never block or throw at
 * startup — the public entry points here catch every error and log a
 * warning instead. Internal helpers use a narrow `safeRead` wrapper so
 * a missing or unreadable file degrades gracefully to an empty string.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { countConversations as countConversationsDb } from "../memory/conversation-queries.js";
import { listConnections } from "../oauth/oauth-store.js";
import { resolveGuardianPersonaPath } from "../prompts/persona-resolver.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getLogger } from "../util/logger.js";
import {
  getDataDir,
  getWorkspaceDir,
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
 * Build a fresh `RelationshipState` snapshot from the current workspace.
 * Reads USER.md / SOUL.md / IDENTITY.md, queries the oauth connection
 * store, and counts conversations via the DB-authoritative helper.
 *
 * Side effect: on the very first call when IDENTITY.md cannot provide
 * a hatched date, `resolveFallbackHatchedDate` persists a one-time
 * `data/hatched.json` sidecar so subsequent calls return a monotonic
 * timestamp. All other paths are read-only. Callers that want to
 * persist the full snapshot should use `writeRelationshipState()`.
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
 * In-module serialization primitive for `writeRelationshipState`.
 *
 * Multiple conversations can finish a turn simultaneously, each firing
 * `void writeRelationshipState()` from `conversation-agent-loop`.
 * Without coalescing, two compute+write cycles can interleave
 * (compute A → compute B → writeSync A → writeSync B), so the
 * persisted snapshot reflects an older state than the last turn and
 * two SSE events fire that don't match the final on-disk content.
 *
 * We use a "latest wins" pattern:
 *   - If no write is in flight, start one.
 *   - If a write is in flight, mark dirty and return the in-flight
 *     promise. Overlapping callers all resolve off the same tail.
 *   - When the in-flight write finishes, if dirty, run again.
 *
 * Guarantees:
 *   - At most one compute+write runs at a time.
 *   - N overlapping callers during one write produce exactly one
 *     tail write, not N.
 *   - The final on-disk state always reflects the latest completed
 *     compute.
 *   - No unbounded queue.
 */
let writeInFlight: Promise<void> | null = null;
let writeDirty = false;

async function runWriteRelationshipState(): Promise<void> {
  let writtenState: RelationshipState | undefined;
  try {
    const state = await computeRelationshipState();
    const path = getRelationshipStatePath();
    mkdirSync(getDataDir(), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
    // Only mark the state as "written" AFTER the sync write has
    // succeeded — any throw from `writeFileSync` short-circuits the
    // SSE emit below so subscribers never see a stale update event
    // that contradicts on-disk state.
    writtenState = state;
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

  // SSE fanout lives outside the try/catch so a publish failure does
  // not get mis-logged as a write failure. Still guarded against the
  // publish throwing (e.g. a subscriber rejects) — the writer promise
  // must never reject from this path.
  if (writtenState) {
    publishRelationshipStateUpdated(writtenState.updatedAt);
  }
}

/**
 * Compute a fresh snapshot and persist it to `getRelationshipStatePath()`.
 *
 * Never throws — all errors are caught and logged as warnings. Fire-and-
 * forget callers (e.g. the conversation-complete hook) can safely call
 * this without additional try/catch wrapping.
 *
 * Concurrent calls are coalesced (see `writeInFlight` above): at most
 * one compute+write runs at a time, and overlapping calls during an
 * in-flight write all resolve off a single tail write that reflects
 * the latest state.
 */
export async function writeRelationshipState(): Promise<void> {
  if (writeInFlight) {
    writeDirty = true;
    return writeInFlight;
  }
  writeInFlight = (async () => {
    try {
      await runWriteRelationshipState();
      while (writeDirty) {
        writeDirty = false;
        await runWriteRelationshipState();
      }
    } finally {
      writeInFlight = null;
    }
  })();
  return writeInFlight;
}

/**
 * Publish the `relationship_state_updated` event to the in-process
 * assistant event hub. Called only on the success branch of
 * `writeRelationshipState()` so the event accurately reflects what
 * just landed on disk.
 */
function publishRelationshipStateUpdated(updatedAt: string): void {
  assistantEventHub
    .publish(
      buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
        type: "relationship_state_updated",
        updatedAt,
      }),
    )
    .catch((err) => {
      log.warn({ err }, "Failed to publish relationship_state_updated event");
    });
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
 * (`users/<slug>.md`). Walks a three-step fallback chain so a transient
 * contact-store failure on a migrated workspace still surfaces real
 * user content:
 *
 *   1. `resolveGuardianPersonaPath()` via contact-store — the canonical
 *      per-guardian slugged file (e.g. `users/sidd.md`).
 *   2. `users/default.md` — the default-guardian persona file that the
 *      workspace migration leaves in place. Catches the window where
 *      the resolver throws or returns null but the file-backed content
 *      is still available.
 *   3. Workspace-root `USER.md` — legacy fallback for very old
 *      workspaces that predate migration 031.
 *
 * Every step is guarded; an empty string is returned only when all
 * three sources are unavailable, so `computeRelationshipState()` never
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
      "Failed to resolve guardian persona path; trying users/default.md",
    );
  }

  // Intermediate fallback: the default-guardian persona file that
  // exists on most migrated workspaces even when the contact store is
  // transiently unreachable.
  try {
    const defaultUserPath = join(getWorkspaceDir(), "users", "default.md");
    const defaultContent = safeRead(defaultUserPath);
    if (defaultContent) return defaultContent;
  } catch (err) {
    log.warn(
      { err },
      "Failed to read users/default.md; trying legacy USER.md",
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

  for (const line of iterateBulletLines(input.userContent)) {
    const parsed = parseBulletLabelValue(line);
    if (!parsed) continue;
    const { label, value } = parsed;
    if (!value) continue;
    const lower = label.toLowerCase();
    const isPriority = priorityKeywords.some((k) => lower.startsWith(k));
    const category: Fact["category"] = isPriority ? "priorities" : "world";
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
 * Count conversations using the DB-authoritative helper from
 * `conversation-queries`. This matches `listConversations()` used by
 * the UI — it filters out `background`, `private`, and `scheduled`
 * conversation types — and is immune to stray filesystem entries like
 * `.DS_Store` or double-counts from workspace migration 009 where
 * legacy + canonical directory forms temporarily co-exist.
 *
 * Returns 0 on any failure (DB not initialized, schema drift, etc.)
 * so the writer still produces a valid snapshot — per module contract
 * this path must never throw.
 */
function countConversations(): number {
  try {
    return countConversationsDb();
  } catch (err) {
    log.warn({ err }, "Failed to count conversations from DB; defaulting to 0");
    return 0;
  }
}

/**
 * Filename for the hatched-date sidecar, used as a stable fallback
 * when IDENTITY.md is missing / unreadable / has no explicit hatched
 * bullet and file stat is unavailable. Lives under the workspace
 * data dir alongside `relationship-state.json`.
 */
const HATCHED_SIDECAR_FILENAME = "hatched.json";

function getHatchedSidecarPath(): string {
  return join(getDataDir(), HATCHED_SIDECAR_FILENAME);
}

/**
 * Resolve a stable hatched-date fallback timestamp.
 *
 * The Swift client, OpenAPI schema, and UI have no special handling
 * for a Unix-epoch sentinel — they'll render "1/1/1970" to the user.
 * Instead, we use `new Date().toISOString()` the first time a
 * fallback is needed and persist it to a small sidecar file
 * (`data/hatched.json`). Subsequent calls read the sidecar first, so
 * the returned timestamp is monotonic across writes and the
 * `hatchedDate` field never drifts once initialized.
 *
 * Never throws — a sidecar read/write failure still yields a valid
 * (though non-stable) `now` timestamp, which is still far better than
 * the epoch sentinel.
 */
function resolveFallbackHatchedDate(): string {
  const path = getHatchedSidecarPath();
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        hatchedAt?: string;
      };
      if (parsed.hatchedAt && !isNaN(Date.parse(parsed.hatchedAt))) {
        return parsed.hatchedAt;
      }
    }
  } catch {
    // Fall through to write a fresh sidecar.
  }
  const now = new Date().toISOString();
  try {
    mkdirSync(getDataDir(), { recursive: true });
    writeFileSync(path, JSON.stringify({ hatchedAt: now }, null, 2), "utf-8");
  } catch {
    // If even the sidecar write fails, return `now` anyway — the
    // caller will just get a fresh-looking date on every call. Not
    // ideal, but far better than the epoch sentinel.
  }
  return now;
}

/**
 * Pull `assistantName` and `hatchedDate` from IDENTITY.md.
 *
 * IDENTITY.md is a freeform markdown file, so for the name we scan
 * bullet lines for any recognizable `name` label (`Name`,
 * `Assistant Name`, `Preferred Name`, etc.). For the hatched date we
 * prefer any explicit `hatched:` / `birth:` bullet, then fall back to
 * the file's `stat.birthtime` (matching the pattern already
 * established by `identity-routes.ts`), and finally to `stat.mtime`
 * if birthtime is unavailable. We never fall back to `new Date()`
 * directly — `writeRelationshipState()` is called on every turn
 * boundary, so a raw `Date.now()` fallback would cause `hatchedDate`
 * to drift forward on every write. Instead, when nothing else is
 * readable we resolve via `resolveFallbackHatchedDate()` which
 * persists a stable timestamp to a sidecar file on first use.
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
    // Accept any label whose lowercased form looks like a "name"
    // label: `Name`, `Assistant Name`, `Preferred Name`, etc.
    // Preserves the "first match wins" precedence so a raw `Name`
    // bullet still takes precedence over later aliases.
    if (
      assistantName === DEFAULT_ASSISTANT_NAME &&
      (lower === "name" ||
        lower === "assistant name" ||
        lower === "preferred name" ||
        lower.startsWith("name"))
    ) {
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
    // File missing or unreadable — fall through to the sidecar.
  }

  // Last-ditch fallback: `resolveFallbackHatchedDate` returns a stable,
  // real timestamp (persisted to `data/hatched.json` on first call) so
  // the wire contract always carries a valid ISO date.
  return { assistantName, hatchedDate: resolveFallbackHatchedDate() };
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
      (lower === "user" ||
        lower === "user name" ||
        lower.startsWith("preferred name") ||
        lower.startsWith("name")) &&
      parsed.value
    ) {
      return parsed.value;
    }
  }
  return undefined;
}
