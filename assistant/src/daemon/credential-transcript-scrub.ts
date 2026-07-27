/**
 * Retroactive transcript scrub for stored credential values (JARVIS-1313).
 *
 * When a credential is stored, its exact plaintext may already sit in recent
 * transcripts: the user message that pasted it, the assistant `tool_use`
 * input that ran `assistant credentials set` (tool inputs are persisted raw
 * — persist-time redaction covers text blocks only), and the tool result
 * echoing the command. This module is the self-healing layer: one call
 * replaces every occurrence of the value with the legacy redaction marker
 * across (a) recent finalized DB message rows, (b) the per-conversation
 * disk-view `messages.jsonl` that feedback exports bundle, and (c) the
 * resident in-memory `Conversation.messages` history the next LLM turn
 * reads.
 *
 * Best-effort by contract: the function never throws, logs only
 * lengths/counts (never secret material), and returns whatever it managed
 * to scrub.
 *
 * Accepted residual — crash during an in-flight turn: a streaming turn's
 * unfinalized row is backed by an on-disk delta file that this sweep does
 * not rewrite (the live turn is covered by the in-memory sweep, and the
 * finalize seam re-runs persist-time redaction). If the daemon crashes
 * after a scrub but before that turn finalizes, boot recovery
 * (`monitoring/recovery/inflight-content.ts`) folds the delta file — which
 * may still hold the plaintext — into a finalized row no future sweep
 * revisits. The window is narrow (crash inside one turn, between a
 * credential store and finalize) and the fold happens without an LLM in
 * the loop; hardening the recovery fold to re-scrub is future work.
 */

import {
  neutralizeRedactedSentinels,
  SENTINEL_REDACTION_VERSION,
} from "@vellumai/service-contracts/redacted-credential";
import { and, eq, gte, or, sql } from "drizzle-orm";

import { updateMessageContent } from "../persistence/conversation-crud.js";
import { rebuildConversationDiskViewFromDbState } from "../persistence/conversation-disk-view.js";
import { getDb } from "../persistence/db-connection.js";
import { enqueueLexicalIndexForMessage } from "../persistence/job-handlers/message-lexical.js";
import { resolveInlineBlockArray } from "../persistence/message-content-file.js";
import { messages } from "../persistence/schema/conversations.js";
import type { ContentBlock } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import {
  credentialValueEncodings,
  LEGACY_CREDENTIAL_REDACTION_MARKER,
} from "./chat-credential-redaction.js";
import {
  allConversations,
  allSubagentConversations,
} from "./conversation-registry.js";
import { getDbMigrationReadiness } from "./daemon-readiness.js";

const log = getLogger("credential-transcript-scrub");

/**
 * Floor below which a value is never scrubbed — short strings are too likely
 * to collide with innocent transcript text. Deliberately stricter than the
 * persist-time `MIN_CANDIDATE_VALUE_LENGTH` (6) in
 * chat-credential-redaction.ts: this sweep rewrites finalized history
 * across whole conversations, so a false-positive match destroys stored
 * text rather than merely redacting a live stream — the higher bar buys
 * collision safety at the cost of skipping very short secrets.
 */
const MIN_SCRUB_VALUE_LENGTH = 8;

/** How far back the DB sweep looks. Bounds the LIKE scan on large tables. */
const SCRUB_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface TranscriptScrubResult {
  dbMessagesScrubbed: number;
  residentMessagesScrubbed: number;
}

/**
 * Scrub every occurrence of `value` from recent transcripts: finalized DB
 * message rows from the last 7 days (with lexical reindex + disk-view
 * rebuild for each touched conversation) and the resident in-memory history
 * of every live conversation, subagents included.
 *
 * Unfinalized (streaming) rows are intentionally skipped: the in-flight turn
 * is covered by the in-memory sweep plus persist-time redaction at the
 * finalize seam.
 *
 * Never throws — partial failures are logged (counts only, never content)
 * and reflected in the best-effort result.
 */
export async function scrubStoredCredentialFromTranscripts(
  value: string,
): Promise<TranscriptScrubResult> {
  const result: TranscriptScrubResult = {
    dbMessagesScrubbed: 0,
    residentMessagesScrubbed: 0,
  };
  if (value.trim().length < MIN_SCRUB_VALUE_LENGTH) {
    return result;
  }
  const targets = buildSearchTargets(value);
  try {
    result.dbMessagesScrubbed = sweepDbMessages(targets);
  } catch (err) {
    log.warn(
      { err, valueLength: value.length },
      "Credential transcript DB sweep failed; continuing with in-memory sweep",
    );
  }
  try {
    result.residentMessagesScrubbed = sweepResidentConversations(targets);
  } catch (err) {
    log.warn(
      { err, valueLength: value.length },
      "Credential transcript in-memory sweep failed",
    );
  }
  return result;
}

/**
 * The vellum platform identity ids and base URL are stored through the
 * credential routes but are not secrets — they are UUIDs/URLs that
 * legitimately appear in conversation text, so scrubbing them would redact
 * benign transcript content. Both credential write paths
 * (`credentials_set` and the `/v1/secrets` credential branch) consult this
 * one exemption so they cannot drift.
 */
export function isNonSecretPlatformField(
  service: string,
  field: string,
): boolean {
  return (
    service === "vellum" &&
    (field === "platform_assistant_id" ||
      field === "platform_organization_id" ||
      field === "platform_user_id" ||
      field === "platform_base_url")
  );
}

/**
 * Every transcript encoding of the value ({@link credentialValueEncodings}:
 * raw plus JSON-escaped — tool_use inputs are stored as JSON, and string
 * leaves can themselves embed JSON-encoded text), plus one further
 * JSON-escape level: when a block string embeds JSON containing the value
 * (e.g. a `tool_use.input.command` carrying inline JSON), the stored
 * column bytes hold the twice-escaped form, and the LIKE prefilter must
 * select that row so the block-level replace (which sees the once-escaped
 * form) can run. Values without JSON metacharacters collapse to a single
 * target, so the common case is unchanged. Deeper nesting is out of
 * scope. Longest first so an escaped form is never half-eaten by its
 * raw twin.
 *
 * Exported for tests.
 */
export function buildSearchTargets(value: string): string[] {
  const seen = new Set(credentialValueEncodings(value));
  for (const encoding of [...seen]) {
    seen.add(JSON.stringify(encoding).slice(1, -1));
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

function replaceTargets(
  text: string,
  targets: readonly string[],
): { text: string; changed: boolean } {
  let out = text;
  for (const target of targets) {
    if (out.includes(target)) {
      out = out.split(target).join(LEGACY_CREDENTIAL_REDACTION_MARKER);
    }
  }
  return { text: out, changed: out !== text };
}

// ── DB sweep ───────────────────────────────────────────────────────

/** Escape `%`, `_`, and `\` so the value is matched literally under `ESCAPE '\'`. */
function escapeLikeLiteral(literal: string): string {
  return literal.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function sweepDbMessages(targets: readonly string[]): number {
  // Module contract: callers can invoke this at any point in the daemon
  // lifecycle, so readiness is checked rather than assumed (see
  // assistant/CLAUDE.md § DB migration readiness gating).
  if (!getDbMigrationReadiness().ready) {
    log.warn(
      "DB migrations not ready; skipping credential transcript DB sweep",
    );
    return 0;
  }
  const cutoff = Date.now() - SCRUB_WINDOW_MS;
  const rows = getDb()
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      content: messages.content,
    })
    .from(messages)
    .where(
      and(
        eq(messages.finalized, 1),
        gte(messages.createdAt, cutoff),
        or(
          ...targets.map(
            (target) =>
              sql`${messages.content} LIKE ${`%${escapeLikeLiteral(target)}%`} ESCAPE '\\'`,
          ),
        ),
      ),
    )
    .all();

  let scrubbed = 0;
  let failures = 0;
  const touchedConversationIds = new Set<string>();
  for (const row of rows) {
    try {
      const next = scrubStoredContent(row.content, targets);
      if (!next.changed) {
        continue;
      }
      updateMessageContent(row.id, next.content);
      // `updateMessageContent` is a pure CRUD primitive: reindex the changed
      // searchable text ourselves (mutate-then-reindex, as consolidation does).
      enqueueLexicalIndexForMessage(row.id);
      touchedConversationIds.add(row.conversationId);
      scrubbed++;
    } catch (err) {
      failures++;
      log.warn(
        { err, messageId: row.id },
        "Failed to scrub credential value from message row",
      );
    }
  }
  // `messages.jsonl` is append-only, so a per-message re-sync would stack a
  // scrubbed line on top of the original. Rebuild each touched
  // conversation's disk view from post-scrub DB state instead.
  for (const conversationId of touchedConversationIds) {
    try {
      rebuildConversationDiskViewFromDbState(conversationId);
    } catch (err) {
      log.warn(
        { err, conversationId },
        "Failed to rebuild disk view after credential scrub",
      );
    }
  }
  // Debug level: the credentials_set route owns the single info-level
  // summary of a scrub run.
  if (scrubbed > 0 || failures > 0) {
    log.debug(
      {
        matchedRows: rows.length,
        scrubbed,
        failures,
        conversations: touchedConversationIds.size,
      },
      "Credential transcript DB sweep complete",
    );
  }
  return scrubbed;
}

/**
 * Scrub a stored `messages.content` column value, preserving each row's
 * stored shape:
 *   - Inline block arrays are repaired via `resolveInlineBlockArray`,
 *     scrubbed per block, and re-serialized.
 *   - JSON-string rows (the `typeof parsed === "string"` shape
 *     `resolveMessageContentBlocks` unwraps) are scrubbed in the PARSED
 *     value and re-encoded with `JSON.stringify` — a byte replace on the
 *     serialized form would splice the marker's unescaped quotes into the
 *     JSON and corrupt the row.
 *   - Anything else — legacy plain-string rows, non-array JSON — gets a
 *     plain textual replace. `{ref}` rows never LIKE-match (the column
 *     holds only the pointer), and the plain replace is a no-op for them.
 */
function scrubStoredContent(
  raw: string,
  targets: readonly string[],
): { content: string; changed: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (Array.isArray(parsed)) {
    const blocks = resolveInlineBlockArray(parsed);
    let changed = false;
    const scrubbedBlocks = blocks.map((block) => {
      const next = scrubBlock(block, targets);
      if (next.changed) {
        changed = true;
      }
      return next.block;
    });
    return changed
      ? { content: JSON.stringify(scrubbedBlocks), changed: true }
      : { content: raw, changed: false };
  }
  if (typeof parsed === "string") {
    const { text, changed } = replaceTargets(parsed, targets);
    return changed
      ? { content: JSON.stringify(text), changed: true }
      : { content: raw, changed: false };
  }
  const { text, changed } = replaceTargets(raw, targets);
  return { content: text, changed };
}

// ── Block walk (shared by DB and in-memory sweeps) ─────────────────

function scrubBlock(
  block: ContentBlock,
  targets: readonly string[],
): { block: ContentBlock; changed: boolean } {
  switch (block.type) {
    case "text": {
      const { text, changed } = replaceTargets(block.text, targets);
      if (!changed) {
        return { block, changed: false };
      }
      // The rider marks the block as redaction-aware, so
      // `renderHistoryContent`'s neutralization boundary trusts the block's
      // sentinels verbatim. Stamping therefore requires the same invariant
      // the persist path establishes (conversation-agent-loop-handlers.ts):
      // every surviving sentinel is redactor-authored. A block without a
      // valid rider predates that guarantee — neutralize any sentinel-shaped
      // strings it carries before stamping, or the stamp would promote a
      // forged `〔redacted:…〕` into a trusted, chip-renderable one.
      const rider = (block as { _redactionVersion?: unknown })
        ._redactionVersion;
      const alreadyNeutralized =
        typeof rider === "number" && rider >= SENTINEL_REDACTION_VERSION;
      return {
        block: {
          ...block,
          text: alreadyNeutralized ? text : neutralizeRedactedSentinels(text),
          _redactionVersion: SENTINEL_REDACTION_VERSION,
        } as ContentBlock,
        changed: true,
      };
    }
    case "tool_use":
    case "server_tool_use": {
      const [input, changed] = scrubJsonLeaves(block.input, targets);
      return changed
        ? {
            block: { ...block, input: input as Record<string, unknown> },
            changed: true,
          }
        : { block, changed: false };
    }
    case "tool_result": {
      let changed = false;
      let content: unknown = block.content;
      if (typeof content === "string") {
        const next = replaceTargets(content, targets);
        content = next.text;
        changed = next.changed;
      } else if (content !== undefined) {
        // Legacy rows can carry nested content arrays/objects.
        [content, changed] = scrubJsonLeaves(content, targets);
      }
      let contentBlocks = block.contentBlocks;
      if (contentBlocks) {
        let nestedChanged = false;
        const nextNested = contentBlocks.map((nested) => {
          const next = scrubBlock(nested, targets);
          if (next.changed) {
            nestedChanged = true;
          }
          return next.block;
        });
        if (nestedChanged) {
          contentBlocks = nextNested;
          changed = true;
        }
      }
      return changed
        ? {
            block: {
              ...block,
              content: content as string,
              ...(contentBlocks ? { contentBlocks } : {}),
            },
            changed: true,
          }
        : { block, changed: false };
    }
    case "thinking": {
      // Provider-signed thinking blocks must stay byte-identical: the
      // signature covers the text, and a rewritten block would be rejected
      // on history replay. Unsigned blocks (this codebase persists
      // signature: "" on the streaming path) carry no such constraint and
      // get the same target replacement as every other string surface.
      if (block.signature !== "" && block.signature !== undefined) {
        return { block, changed: false };
      }
      const { text, changed } = replaceTargets(block.thinking, targets);
      return changed
        ? { block: { ...block, thinking: text }, changed: true }
        : { block, changed: false };
    }
    default:
      return { block, changed: false };
  }
}

/** Recursively replace targets in every string leaf of a JSON-shaped value. */
function scrubJsonLeaves(
  value: unknown,
  targets: readonly string[],
): [unknown, boolean] {
  if (typeof value === "string") {
    const { text, changed } = replaceTargets(value, targets);
    return [text, changed];
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const [scrubbedItem, itemChanged] = scrubJsonLeaves(item, targets);
      if (itemChanged) {
        changed = true;
      }
      return scrubbedItem;
    });
    return changed ? [next, true] : [value, false];
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const [scrubbedEntry, entryChanged] = scrubJsonLeaves(entry, targets);
      if (entryChanged) {
        changed = true;
      }
      next[key] = scrubbedEntry;
    }
    return changed ? [next, true] : [value, false];
  }
  return [value, false];
}

// ── In-memory sweep ────────────────────────────────────────────────

/**
 * Scrub the live `Conversation.messages` history of every resident
 * conversation (top-level and subagent). The next LLM turn reads this
 * in-memory history — hydrated once in `loadFromDb` — not the DB, so the DB
 * sweep alone would leave the value in context until eviction. No
 * persistence side effects: durable copies are the DB sweep's job.
 */
function sweepResidentConversations(targets: readonly string[]): number {
  let scrubbed = 0;
  for (const registry of [allConversations(), allSubagentConversations()]) {
    for (const conversation of registry) {
      for (const message of conversation.messages) {
        if (!Array.isArray(message.content)) {
          continue;
        }
        let changed = false;
        const content = message.content.map((block) => {
          const next = scrubBlock(block, targets);
          if (next.changed) {
            changed = true;
          }
          return next.block;
        });
        if (changed) {
          message.content = content;
          scrubbed++;
        }
      }
    }
  }
  return scrubbed;
}
