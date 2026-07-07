/**
 * Assistant-driven context compaction.
 *
 * When a conversation grows long, we hand the model the entire conversation
 * plus an appended instruction message and let it write its own summary,
 * choose its own cut point, and decide which images to retain.
 *
 * The instruction message is appended as a `user`-role message at the tail
 * so the full conversation prefix (system prompt + tools + messages) remains
 * cacheable across compaction calls.
 *
 * The model responds with a `<compaction_result>` XML block. We parse it,
 * resolve `tail_start` to a message index, re-attach any retained images,
 * and rebuild the conversation as:
 *
 *   [<assistant summary>, <retained-image user message?>, ...tail]
 *
 * On any parse or resolution failure we abort the compaction and return
 * `compacted: false` — never silently lose messages.
 */
import { optimizeImageForTransport } from "../agent/image-optimize.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { CompactionConfig } from "../config/schemas/compaction.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { filterMessagesForUntrustedActor } from "../daemon/message-provenance.js";
import {
  getAttachmentContent,
  getAttachmentMetadataForMessage,
} from "../persistence/attachments-store.js";
import { getMessages } from "../persistence/conversation-crud.js";
import { recordRequestLog } from "../persistence/llm-request-log-store.js";
import { getCatalogModelVision } from "../providers/model-catalog.js";
import type {
  ContentBlock,
  ImageContent,
  Message,
  Provider,
  ProviderResponse,
  ToolDefinition,
} from "../providers/types.js";
import { type TrustClass } from "../runtime/actor-trust-resolver.js";
import { resolveCapabilities } from "../runtime/capabilities.js";
import { getLogger } from "../util/logger.js";
import { preModelCallSanitize } from "./outbound-sanitize.js";
import { stripInjectionsForCompaction } from "./strip-injections.js";
import {
  estimatePromptTokens,
  estimateToolsTokens,
} from "./token-estimator.js";

const log = getLogger("compactor");

/**
 * Stable call-site identifier used when invoking the provider for a
 * compaction pass. Using `mainAgent` (rather than a dedicated
 * `conversationCompaction` site) keeps the resolved provider/model/system
 * prompt/tools identical to the agent's last turn, so the prefix cache hit
 * rate is maximized — the compaction-instruction user message is the only
 * new token sequence.
 */
const COMPACTION_CALL_SITE: LLMCallSite = "mainAgent";

/**
 * Tag stamped on `llm_request_logs.call_site` for compaction-driven rows.
 *
 * Distinct from `COMPACTION_CALL_SITE` (above) on purpose: that constant
 * names the **provider config resolution** site (set to `mainAgent` so we
 * inherit the agent's profile and keep the prefix cache warm). This
 * constant names the **observability** site — what the row IS — so
 * inspectors can filter "show me only compaction calls". They're
 * semantically different even though both come from the same enum.
 */
const COMPACTION_LOG_CALL_SITE: LLMCallSite = "compactionAgent";

/**
 * Best-effort: persist a successful compaction LLM call into
 * `llm_request_logs` with `call_site = "compactionAgent"`. The compactor
 * opts out of automatic usage tracking (`usageTracking: "manual"`), so
 * its calls otherwise never reach `recordRequestLog` via the agent-loop
 * dispatcher. Failures are swallowed (warn-logged) so a DB hiccup never
 * escalates compaction into a failure.
 */
function recordCompactionRequestLog(
  conversationId: string,
  response: ProviderResponse,
  provider: Provider,
): void {
  if (!response.rawRequest || !response.rawResponse) return;
  try {
    recordRequestLog(
      conversationId,
      JSON.stringify(response.rawRequest),
      JSON.stringify(response.rawResponse),
      undefined,
      response.actualProvider ?? provider.name,
      COMPACTION_LOG_CALL_SITE,
    );
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Failed to persist compaction LLM request log (non-fatal)",
    );
  }
}

/**
 * Whether the model the compacted context is rebuilt for accepts image input.
 *
 * Resolves `mainAgent` + the conversation's override profile — the same
 * inputs the compaction `sendMessage` (and the agent's next turn) resolve —
 * and checks the catalog's vision flag for the resolved model. Only an
 * explicit catalog `supportsVision: false` disables retention; unknown models
 * fail open so uncataloged setups keep today's behavior. Resolution errors
 * also fail open — a config problem surfaces on the provider call itself, not
 * here.
 */
function compactionModelSupportsImages(
  overrideProfile: string | null | undefined,
): boolean {
  try {
    const resolved = resolveCallSiteConfig(
      COMPACTION_CALL_SITE,
      getConfig().llm,
      overrideProfile ? { overrideProfile } : {},
    );
    return getCatalogModelVision(resolved.model) !== false;
  } catch {
    return true;
  }
}

const RESULT_TAG_OPEN = "<compaction_result>";
const RESULT_TAG_CLOSE = "</compaction_result>";

/**
 * Generic compaction instruction. Used when `compaction.prompt` is unset.
 *
 * `{image_manifest}` is the only interpolation point. Custom prompts in
 * `config.json` go through the same interpolation, so override authors can
 * place the placeholder wherever they want.
 */
export const DEFAULT_COMPACTION_PROMPT = `<compaction_instructions>
This conversation is getting long. It's time to run a compaction pass.

You have the full conversation in your context right now. Your job is to
compress the older parts into a summary while preserving recent messages
exactly as they are.

Write the summary in YOUR voice — as if you're remembering this conversation,
not writing meeting notes about it. Prioritize:
- Decisions made and commitments given
- Key context that's still relevant going forward
- Emotional moments that shaped the conversation's direction
- Exact quotes when the specific wording matters
- Project/task state changes

Compress aggressively:
- Repeated debugging or troubleshooting attempts → just the outcome
- Tool call outputs → results only, not raw data
- Intermediate states superseded by later states
- Back-and-forth deliberation → just the conclusion

For picking where to cut between summary and preserved tail:
- Find the last major topic shift or energy change
- Keep the active thread of conversation fully intact
- Keep the verbatim tail within roughly {tail_budget} tokens so the
  compacted conversation has room to breathe before the next pass
- Never cut in the middle of an ongoing discussion

IMAGE MANIFEST (images in this conversation):
{image_manifest}

If any images from the summarized portion are still relevant to the
ongoing conversation, include them in retained_images by filename.

Output your result in this exact format:

<compaction_result>
<summary>
Your summary in your voice. Aim for 2000-4000 tokens — rich enough
to preserve what matters, compact enough to free real space.
</summary>

<key_state>
Short structured list of anything PENDING from this conversation:
active decisions, open questions, commitments, project states.
</key_state>

<retained_images>
<image file="filename.ext" />
(only images from BEFORE the tail that are still contextually important)
(omit this section entirely if no images need retention)
</retained_images>

<tail_start
  timestamp="[exact timestamp from the turn_context of the first message to preserve verbatim]"
  preview="[first ~60 characters of that message for verification]" />
</compaction_result>
</compaction_instructions>`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CompactionRunArgs {
  conversationId: string;
  messages: Message[];
  provider: Provider;
  systemPrompt: string;
  tools?: ToolDefinition[];
  compaction: CompactionConfig;
  /** Effective context window for the conversation (in tokens). */
  maxInputTokens: number;
  /**
   * Low-watermark token budget the rebuilt history (summary + verbatim tail)
   * should land at or below after a successful pass. Drives the deterministic
   * forward-cut that advances the model's tail choice until the estimate fits,
   * so one pass buys a long quiet period instead of landing a hair under the
   * trigger. When omitted the forward-cut is skipped (legacy/emergency paths).
   */
  targetTokens?: number;
  /** Pre-computed estimated input tokens for the live history. */
  previousEstimatedInputTokens: number;
  /** Skip the autoThreshold check — fire compaction unconditionally. */
  force?: boolean;
  signal?: AbortSignal;
  overrideProfile?: string | null;
  /**
   * Trust class of the actor whose turn triggered compaction. When the
   * actor is untrusted, the image manifest is filtered to exclude
   * guardian-only attachments so they cannot be retained back into the
   * untrusted actor's context.
   */
  actorTrustClass?: TrustClass;
  /**
   * Number of leading non-persisted messages (e.g. inherited summary from a
   * parent fork). Compacted-persisted-count subtracts this so the DB
   * `contextCompactedMessageCount` only advances by rows that actually have
   * DB counterparts.
   */
  nonPersistedPrefixCount?: number;
}

export interface CompactionRunResult {
  messages: Message[];
  compacted: boolean;
  previousEstimatedInputTokens: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  thresholdTokens: number;
  compactedMessages: number;
  compactedPersistedMessages: number;
  /**
   * Number of recent ("tail") messages preserved verbatim alongside the
   * summary. Omitted on no-op / skipped results — defaults to 0 at render.
   */
  preservedTailMessages?: number;
  summaryCalls: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  summaryModel: string;
  summaryCallSite?: LLMCallSite;
  summaryOverrideProfile?: string | null;
  summaryCacheCreationInputTokens?: number;
  summaryCacheReadInputTokens?: number;
  summaryRawResponses?: unknown[];
  summaryText: string;
  /** Inline structured pending state from the model's `<key_state>` block. */
  keyState?: string;
  reason?: string;
  /** True when the provider call threw and no compaction was applied. */
  summaryFailed?: boolean;
  /**
   * Set on a successful pass when the deterministic forward-cut advanced to the
   * tail floor (the start of the most recent complete exchange) but the rebuilt
   * history still exceeds `targetTokens`. The verbatim tail alone — the
   * in-flight turn during a tool-heavy round — is over budget, and no boundary
   * the cut can reach fits it. The window-manager's retry loop reads this to
   * stop retrying immediately: a second full-context pass would land on the same
   * floor and free nothing, just paying another full cache write. Omitted (and
   * treated as `false`) on no-op / skipped / legacy (`targetTokens` absent)
   * results. Internal-result-only — not persisted or emitted on any external
   * wire payload.
   */
  tailFloorReached?: boolean;
}

export interface ParsedCompactionResult {
  summary: string;
  keyState: string;
  retainedImageFilenames: string[];
  tailStartTimestamp: string;
  tailStartPreview: string;
}

// ---------------------------------------------------------------------------
// XML parser
// ---------------------------------------------------------------------------

/**
 * Extract the `<compaction_result>` block from raw assistant output and
 * pull out `<summary>`, `<key_state>`, `<retained_images>` (filenames),
 * and `<tail_start>` (timestamp + preview).
 *
 * Lenient by design — the model may wrap the block in narration, may omit
 * `<retained_images>`, and may produce slightly malformed inner tags. We
 * accept any of those. Returns `null` only when the required fields
 * (summary + tail_start.timestamp) are missing.
 */
export function parseCompactionResult(
  raw: string,
): ParsedCompactionResult | null {
  const openIdx = raw.indexOf(RESULT_TAG_OPEN);
  if (openIdx < 0) return null;
  const closeIdx = raw.lastIndexOf(RESULT_TAG_CLOSE);
  const inner =
    closeIdx > openIdx
      ? raw.slice(openIdx + RESULT_TAG_OPEN.length, closeIdx)
      : raw.slice(openIdx + RESULT_TAG_OPEN.length);

  const summary = extractTagContent(inner, "summary")?.trim() ?? "";
  if (summary.length === 0) return null;

  const keyState = extractTagContent(inner, "key_state")?.trim() ?? "";

  const tail = extractTailStart(inner);
  if (!tail || tail.timestamp.length === 0) return null;

  const retainedImageFilenames = extractRetainedImages(inner);

  return {
    summary,
    keyState,
    retainedImageFilenames,
    tailStartTimestamp: tail.timestamp,
    tailStartPreview: tail.preview,
  };
}

function extractTagContent(haystack: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const openIdx = haystack.indexOf(open);
  if (openIdx < 0) return null;
  const closeIdx = haystack.indexOf(close, openIdx + open.length);
  if (closeIdx < 0) return null;
  return haystack.slice(openIdx + open.length, closeIdx);
}

function extractTailStart(
  inner: string,
): { timestamp: string; preview: string } | null {
  // Match `<tail_start ... />` or `<tail_start ...></tail_start>` with
  // attributes in any order. We require at least `timestamp="..."`.
  const tagMatch = inner.match(
    /<tail_start\b([\s\S]*?)(?:\/>|<\/tail_start>)/i,
  );
  if (!tagMatch) return null;
  const attrs = tagMatch[1];
  const timestamp = extractAttr(attrs, "timestamp") ?? "";
  const preview = extractAttr(attrs, "preview") ?? "";
  return { timestamp, preview };
}

function extractAttr(attrs: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i");
  const m = attrs.match(pattern);
  return m ? m[1] : null;
}

function extractRetainedImages(inner: string): string[] {
  const block = extractTagContent(inner, "retained_images");
  if (block == null) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<image\b[^>]*\bfile\s*=\s*"([^"]+)"[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const name = m[1].trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Image manifest
// ---------------------------------------------------------------------------

interface ManifestEntry {
  filename: string;
  attachmentId: string;
  role: "user" | "assistant" | string;
  timestamp: number;
}

/**
 * Walk the DB rows for the conversation and build an entry per image
 * attachment. Returns entries sorted by message createdAt ascending. The
 * `filename` is the attachment's `originalFilename`; collisions across
 * messages are kept as separate entries (the model can disambiguate via
 * the timestamp it sees in the manifest).
 *
 * For untrusted actors the rows are first filtered through
 * {@link filterMessagesForUntrustedActor} — the same provenance filter
 * `loadFromDb` applies when assembling history — so guardian-only images
 * never enter the manifest and therefore can never be retained back into
 * an untrusted actor's view.
 */
export function collectImageManifest(
  conversationId: string,
  actorTrustClass?: TrustClass,
): ManifestEntry[] {
  const allRows = getMessages(conversationId);
  const rows = !resolveCapabilities(actorTrustClass).canAccessMemory
    ? filterMessagesForUntrustedActor(allRows)
    : allRows;
  const entries: ManifestEntry[] = [];
  for (const row of rows) {
    const atts = getAttachmentMetadataForMessage(row.id);
    for (const att of atts) {
      if (att.kind !== "image") continue;
      entries.push({
        filename: att.originalFilename,
        attachmentId: att.id,
        role: row.role,
        timestamp: row.createdAt,
      });
    }
  }
  return entries;
}

export function renderImageManifest(entries: ManifestEntry[]): string {
  if (entries.length === 0) return "(no images in this conversation)";
  return entries
    .map((e) => {
      const ts = new Date(e.timestamp).toISOString();
      return `- ${e.filename} (${e.role} message at ${ts})`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Timestamp extraction from live messages
// ---------------------------------------------------------------------------

/**
 * Extract the `current_time:` value from a user message's `<turn_context>`
 * block, if present. Returns the raw timestamp string (whatever format the
 * runtime emitted — typically
 * `2026-04-02 (Thursday) 01:52:33 -05:00 (America/Chicago)`).
 */
export function extractTurnContextTimestamp(message: Message): string | null {
  if (message.role !== "user") return null;
  for (const block of message.content) {
    if (block.type !== "text") continue;
    const text = block.text;
    const idx = text.indexOf("<turn_context>");
    if (idx < 0) continue;
    const end = text.indexOf("</turn_context>", idx);
    const slice = end > 0 ? text.slice(idx, end) : text.slice(idx);
    const m = slice.match(/current_time:\s*([^\n]+)/);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Build a parallel array of timestamp strings — one per message — used to
 * resolve the model's `tail_start.timestamp` back to a message index.
 *
 * Assistant and tool-result-only messages get `null` (they have no
 * turn_context); the resolver walks forward from the matched index to
 * include the surrounding user→assistant cluster.
 */
function buildTimestampIndex(messages: Message[]): (string | null)[] {
  return messages.map((m) => extractTurnContextTimestamp(m));
}

function extractFirstTextPreview(message: Message, maxChars = 120): string {
  for (const block of message.content) {
    if (block.type !== "text") continue;
    let text = block.text;
    // Skip injected blocks (`<turn_context>`, `<memory>`, `<workspace>`, ...) —
    // they're not what the model means by "first 60 chars of that message".
    while (text.startsWith("<") && text.includes("</")) {
      const closeMatch = text.match(/<\/[a-zA-Z_][\w-]*>\s*\n?/);
      if (!closeMatch || closeMatch.index === undefined) break;
      text = text.slice(closeMatch.index + closeMatch[0].length).trimStart();
    }
    if (text.length === 0) continue;
    return text.slice(0, maxChars);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Tail resolution
// ---------------------------------------------------------------------------

/**
 * Reduce a timestamp string to a canonical `YYYY-MM-DDTHH:MM:SS` form by
 * extracting the date and time components and discarding everything else
 * (weekday names, parens, timezone offsets, timezone names, separators).
 *
 * The stored format is e.g. `2026-04-02 (Thursday) 01:52:33 -05:00 (America/Chicago)`.
 * Models routinely paraphrase this — dropping the weekday, dropping the
 * timezone, switching to ISO-8601 with a `T` separator. As long as the
 * model's emission contains a date and a time, both reduce to the same
 * canonical key and we can match.
 *
 * Returns null when no date+time pair is detected.
 */
export function canonicalDateTimeKey(ts: string): string | null {
  const m = ts.match(/(\d{4}-\d{2}-\d{2})\D+(\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  return `${m[1]}T${m[2]}`;
}

/**
 * Resolve the model's `tail_start` reference to an index in the live
 * messages array. Match priority:
 *   1. Exact timestamp match against a `<turn_context>` `current_time:` line
 *   2. Substring match (model may emit a shortened or re-formatted ts)
 *   3. Canonical date+time match (tolerant of weekday/timezone paraphrasing)
 *   4. Preview-text fallback — locate the message whose first non-injection
 *      text starts with the preview string
 */
function resolveTailStartIndex(
  messages: Message[],
  timestamps: (string | null)[],
  parsed: ParsedCompactionResult,
): number | null {
  const wantedTs = parsed.tailStartTimestamp.trim();
  if (wantedTs.length > 0) {
    for (let i = 0; i < timestamps.length; i++) {
      if (timestamps[i] === wantedTs) return i;
    }
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      if (ts && (ts.includes(wantedTs) || wantedTs.includes(ts))) return i;
    }
    const wantedKey = canonicalDateTimeKey(wantedTs);
    if (wantedKey) {
      for (let i = 0; i < timestamps.length; i++) {
        const ts = timestamps[i];
        if (!ts) continue;
        if (canonicalDateTimeKey(ts) === wantedKey) return i;
      }
    }
  }
  const wantedPreview = parsed.tailStartPreview.trim();
  if (wantedPreview.length > 0) {
    const previewHead = wantedPreview.slice(0, 40);
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== "user") continue;
      const head = extractFirstTextPreview(m);
      if (head.length > 0 && head.startsWith(previewHead)) return i;
    }
  }
  return null;
}

/**
 * Walk a model-chosen tail index backward until it lands on a user message
 * that does not contain client-side `tool_result` blocks. Prevents the
 * orphan-`tool_result` failure where the matching assistant `tool_use` sits
 * in the discarded prefix and Anthropic rejects the next call with
 * `unexpected tool_use_id found in tool_result blocks`.
 *
 * Walking back (rather than forward) preserves the recent context the model
 * deliberately chose to keep; the tail just expands by the few messages
 * needed to re-anchor the orphaned `tool_result` against its `tool_use`.
 *
 * Returns 0 when the walk falls off the front — the caller treats this as
 * "nothing to compact" via the existing `tailIndex === 0` branch.
 *
 * Only `type === "tool_result"` blocks count. Server-side tools
 * (`server_tool_use` / `web_search_tool_result`) are self-paired inside an
 * assistant message and never trigger an adjustment.
 */
export function adjustTailIndexForToolPairing(
  messages: Message[],
  tailIndex: number,
): number {
  let k = tailIndex;
  while (k > 0) {
    const m = messages[k];
    if (
      m.role === "user" &&
      // guard:allow-tool-result-only — server-side web_search_tool_result is
      // self-paired inside its assistant message and never spans user turns.
      !m.content.some((block) => block.type === "tool_result")
    ) {
      return k;
    }
    k--;
  }
  return 0;
}

/**
 * Whether keeping `messages[index..]` as the verbatim tail lands on a clean
 * boundary: the tail must open on a user turn that does not lead with a
 * client-side `tool_result` (which would orphan its matching `tool_use` in the
 * summarized prefix). This is the forward-walk dual of
 * {@link adjustTailIndexForToolPairing}'s backward walk — the deterministic
 * budget enforcement only advances the cut to indices that satisfy it.
 */
function isForwardCutBoundary(messages: Message[], index: number): boolean {
  const m = messages[index];
  if (m == null || m.role !== "user") return false;
  // guard:allow-tool-result-only — server-side web_search_tool_result is
  // self-paired inside its assistant message and never spans user turns.
  return !m.content.some((block) => block.type === "tool_result");
}

/** Outcome of the deterministic forward-cut budget enforcement. */
interface ForwardCutOutcome {
  /** The chosen tail index (≥ `startIndex`, ≤ `floorIndex`). */
  index: number;
  /**
   * True when the cut ran out of forward boundaries — it advanced to (or could
   * not advance past) the tail floor — yet the rebuilt-history estimate still
   * exceeds `targetTokens`. Signals to the retry loop that a second pass cannot
   * do better: the floor is the same and another full-context LLM pass would
   * land on the same over-budget tail. See {@link CompactionRunResult.tailFloorReached}.
   */
  tailFloorReached: boolean;
}

/**
 * Deterministic low-watermark enforcement. Given the model's tail choice
 * (already resolved + back-walked for tool pairing), advance the cut FORWARD —
 * dropping more leading messages into the summarized region, keeping a smaller
 * verbatim tail — until the rebuilt-history estimate fits `targetTokens` or a
 * minimum-tail floor is hit.
 *
 * The floor preserves conversational integrity: it never advances past
 * `floorIndex`, which the caller anchors to the start of the most recent
 * complete user→assistant exchange so the current in-flight turn is never cut.
 * Every candidate cut must pass {@link isForwardCutBoundary} so tool pairs are
 * never orphaned. Returns the original `startIndex` unchanged when the model's
 * own tail already fits the budget (the cut is enforcement, not optimization)
 * or when no forward boundary improves on it.
 *
 * Reports `tailFloorReached` when the cut exhausts its forward boundaries (the
 * loop never broke early on a fit) while the best tail it found is still over
 * `targetTokens` — the floor-dominated case where the verbatim tail (the
 * in-flight turn during a tool-heavy round) alone exceeds the budget. The
 * window-manager reads this to skip a futile second pass.
 */
function advanceTailForBudget(args: {
  messages: Message[];
  startIndex: number;
  floorIndex: number;
  targetTokens: number;
  estimateTail: (tail: Message[]) => number;
}): ForwardCutOutcome {
  const { messages, startIndex, floorIndex, targetTokens, estimateTail } = args;
  // The model's own tail choice already fits — keep it untouched. Without this
  // early return the loop below would advance to the first forward boundary
  // regardless (smaller tails also fit), needlessly dropping verbatim messages
  // the budget never required us to drop.
  if (estimateTail(messages.slice(startIndex)) <= targetTokens) {
    return { index: startIndex, tailFloorReached: false };
  }
  let chosen = startIndex;
  let fits = false;
  for (let i = startIndex + 1; i <= floorIndex; i++) {
    if (!isForwardCutBoundary(messages, i)) continue;
    chosen = i;
    const estimate = estimateTail(messages.slice(i));
    if (estimate <= targetTokens) {
      fits = true;
      break;
    }
  }
  return { index: chosen, tailFloorReached: !fits };
}

/**
 * Anchor index for the forward-cut floor: the start of the most recent
 * complete user→assistant exchange. The deterministic budget enforcement never
 * advances the cut past this point, so a single pass always preserves at least
 * the latest finished exchange and never bites into the current in-flight turn.
 *
 * Walks back from the end to the last assistant message, then back to the user
 * message that opens its exchange (the nearest preceding clean user boundary).
 * Falls back to the model's chosen `tailIndex` when no such exchange exists
 * (e.g. the tail is a single in-flight turn), which makes the enforcement a
 * no-op rather than cutting too aggressively.
 */
function resolveTailFloorIndex(messages: Message[], tailIndex: number): number {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i > tailIndex; i--) {
    if (messages[i].role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0) return tailIndex;
  for (let i = lastAssistant - 1; i > tailIndex; i--) {
    if (isForwardCutBoundary(messages, i)) return i;
  }
  return tailIndex;
}

// ---------------------------------------------------------------------------
// Retained-image hydration
// ---------------------------------------------------------------------------

function buildRetainedImageBlocks(
  filenames: string[],
  manifest: ManifestEntry[],
): { blocks: ImageContent[]; resolved: string[]; missing: string[] } {
  const blocks: ImageContent[] = [];
  const resolved: string[] = [];
  const missing: string[] = [];
  for (const name of filenames) {
    const entry = manifest.find((e) => e.filename === name);
    if (!entry) {
      missing.push(name);
      continue;
    }
    const content = getAttachmentContent(entry.attachmentId);
    if (!content) {
      missing.push(name);
      continue;
    }
    const sourceMime = guessMimeFromFilename(name);
    // Run the same downscale pass the agent uses when first sending an
    // image. Without this, attachments that exceed the provider's per-image
    // byte limit (Anthropic: 5 MB) crash the next turn after compaction.
    const optimized = optimizeImageForTransport(
      content.toString("base64"),
      sourceMime,
    );
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: optimized.mediaType,
        data: optimized.data,
      },
    });
    resolved.push(name);
  }
  return { blocks, resolved, missing };
}

function guessMimeFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

// ---------------------------------------------------------------------------
// Instruction message
// ---------------------------------------------------------------------------

export function buildInstructionMessage(
  customPrompt: string | null | undefined,
  imageManifest: string,
  tailBudgetTokens?: number,
): Message {
  const template =
    customPrompt && customPrompt.trim().length > 0
      ? customPrompt
      : DEFAULT_COMPACTION_PROMPT;
  // `{tail_budget}` is a soft nudge — the deterministic forward-cut downstream
  // is what actually enforces the budget. Custom prompts without the
  // placeholder render unchanged; the default prompt always carries it.
  const tailBudgetText =
    tailBudgetTokens != null && tailBudgetTokens > 0
      ? String(tailBudgetTokens)
      : "as few as needed";
  const text = template
    .replace("{image_manifest}", imageManifest)
    .replace("{tail_budget}", tailBudgetText);
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

// ---------------------------------------------------------------------------
// Summary message construction
// ---------------------------------------------------------------------------

/**
 * Stitch summary + key_state into the assistant-role memory message that
 * heads the compacted context. Kept as a single block so downstream
 * lifecycle code can rehydrate it with the existing `contextSummary` text
 * column without needing a parallel `keyState` column.
 */
export function buildSummaryMemoryText(
  summary: string,
  keyState: string,
): string {
  const trimmedSummary = summary.trim();
  const trimmedKey = keyState.trim();
  if (trimmedKey.length === 0) return trimmedSummary;
  return `${trimmedSummary}\n\n## Pending State\n${trimmedKey}`;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function emptyResult(
  args: CompactionRunArgs,
  thresholdTokens: number,
  reason: string,
): CompactionRunResult {
  return {
    messages: args.messages,
    compacted: false,
    previousEstimatedInputTokens: args.previousEstimatedInputTokens,
    estimatedInputTokens: args.previousEstimatedInputTokens,
    maxInputTokens: args.maxInputTokens,
    thresholdTokens,
    compactedMessages: 0,
    compactedPersistedMessages: 0,
    summaryCalls: 0,
    summaryInputTokens: 0,
    summaryOutputTokens: 0,
    summaryModel: "",
    summaryText: "",
    reason,
  };
}

function extractTextFromResponse(content: ContentBlock[]): string {
  return content
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n");
}

// Build the outbound message list for a compaction provider call: apply the
// same pre-send sanitization bundle as the agent loop's model calls
// (`preModelCallSanitize` — old tool-result media stripped, AX trees
// collapsed, historical web-search results converted to text), then append
// the summarization instruction at the tail.
//
// Matching the loop's projection matters for two reasons. First, the summary
// call's prefix stays byte-aligned with the agent's warm prompt cache — an
// unsanitized history diverges from what the loop actually sent at the first
// stripped block. Second, an unsanitized history carries every screenshot in
// the conversation; enough images cross Anthropic's many-image threshold,
// where a stricter per-image dimension cap applies and a single large
// screenshot rejects the whole summary call. Sanitizing here — the single
// seam every compaction provider call funnels through — covers both the
// assistant-driven and emergency summarization calls. Only this outbound copy
// is sanitized; tail resolution and the persisted compaction result read the
// caller's original messages, so durable history keeps the rich blocks. The
// instruction stays at the tail so the prefix cache stays warm.
function buildCompactionRequest(
  history: Message[],
  instruction: Message,
): Message[] {
  return [...preModelCallSanitize(history), instruction];
}

// Token headroom a compaction summary call reserves on top of its history: room
// for the instruction message and the summary the model emits, so a request
// front-truncated to `compactionPrefixBudget` still fits the context window.
const COMPACTION_INSTRUCTION_TOKEN_RESERVE = 800;
const COMPACTION_OUTPUT_BUDGET_RATIO = 0.15;

// Largest history (in estimated tokens) a compaction summary call may carry
// while leaving room for the instruction and the emitted summary within
// `maxInputTokens`.
function compactionPrefixBudget(maxInputTokens: number): number {
  return (
    maxInputTokens -
    COMPACTION_INSTRUCTION_TOKEN_RESERVE -
    Math.floor(maxInputTokens * COMPACTION_OUTPUT_BUDGET_RATIO)
  );
}

// Front-truncate the history handed to a compaction summary call so the call
// itself fits the context window. Drops messages from the front until the
// estimated prompt fits `budgetTokens`, then prepends a marker noting how many
// were dropped so the model knows the summary covers only the visible portion.
// Returns the input untouched when it already fits or holds a single message —
// so a below-budget call keeps its prefix byte-aligned with the agent's warm
// cache and pays no extra cache write.
function truncateHistoryToBudget(args: {
  messages: Message[];
  systemPrompt: string;
  budgetTokens: number;
  providerName: string;
}): Message[] {
  const { messages, systemPrompt, budgetTokens, providerName } = args;
  let estimate = estimatePromptTokens(messages, systemPrompt, { providerName });
  if (estimate <= budgetTokens || messages.length <= 1) {
    return messages;
  }
  let dropCount = 0;
  while (estimate > budgetTokens && dropCount < messages.length - 1) {
    dropCount++;
    estimate = estimatePromptTokens(messages.slice(dropCount), systemPrompt, {
      providerName,
    });
  }
  if (dropCount === 0) {
    return messages;
  }
  log.info(
    { dropCount, budgetTokens, totalMessages: messages.length },
    "Compaction summary input exceeds context window — truncating from front",
  );
  return [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `[${dropCount} earlier messages truncated — summary covers only the visible portion]`,
        },
      ],
    },
    ...messages.slice(dropCount),
  ];
}

export async function runAssistantDrivenCompaction(
  args: CompactionRunArgs,
): Promise<CompactionRunResult> {
  const thresholdTokens = Math.floor(
    args.maxInputTokens * args.compaction.autoThreshold,
  );

  if (!args.compaction.enabled) {
    return emptyResult(args, thresholdTokens, "compaction disabled");
  }

  if (!args.force && args.previousEstimatedInputTokens < thresholdTokens) {
    return emptyResult(args, thresholdTokens, "below auto threshold");
  }

  if (args.messages.length === 0) {
    return emptyResult(args, thresholdTokens, "no messages to compact");
  }

  // Image retention only makes sense when the model consuming the compacted
  // context accepts image input. Retained images are re-attached as raw image
  // blocks in the rebuilt history, so a text-only model (e.g. a catalog entry
  // with `supportsVision: false`) would have its next request rejected
  // wholesale by the provider — and since the compacted context is persisted,
  // every subsequent turn on that profile fails the same way. Gate on the same
  // call-site resolution the summary call below uses.
  const retainImages = compactionModelSupportsImages(args.overrideProfile);

  // Build image manifest from the DB before invoking the model so the
  // instruction message carries a faithful picture of available images.
  // Filtered by actor trust so untrusted turns never see guardian-only
  // attachments. An empty manifest tells the model there is nothing to
  // retain, so a text-only pass never invites retention it cannot honor.
  const manifest = retainImages
    ? collectImageManifest(args.conversationId, args.actorTrustClass)
    : [];
  const manifestText = retainImages
    ? renderImageManifest(manifest)
    : "(image retention unavailable: the active model does not accept image input)";
  const instruction = buildInstructionMessage(
    args.compaction.prompt ?? null,
    manifestText,
    args.targetTokens,
  );

  // Bound the summary call's own input to the context window. With no tool
  // pair to anchor an emergency split, an overflow recovery routes the full
  // history straight here, so the summary call must front-truncate itself or
  // it overflows in turn. Truncation operates on the sanitized projection
  // (what the request actually carries) so the budget estimate is honest —
  // estimating on raw history would count media bytes the request strips.
  // `args.messages` stays intact for tail resolution below — only the
  // outbound request is truncated. A below-budget history is returned
  // untouched, keeping the prefix aligned with the agent's warm cache.
  const summaryHistory = truncateHistoryToBudget({
    messages: preModelCallSanitize(args.messages),
    systemPrompt: args.systemPrompt,
    budgetTokens: compactionPrefixBudget(args.maxInputTokens),
    providerName: args.provider.tokenEstimationProvider ?? args.provider.name,
  });
  const requestMessages = buildCompactionRequest(summaryHistory, instruction);

  let response: ProviderResponse;
  try {
    response = await args.provider.sendMessage(requestMessages, {
      // Tools are passed so the cached prefix (system prompt + tools +
      // history) matches the agent's main-turn cache key. Force
      // `tool_choice: "none"` so the model can only answer with the
      // `<compaction_result>` text and never burns the turn on a tool call
      // it cannot complete — an empty text response yields no parseable
      // summary, stalls compaction, and exhausts the agent loop budget.
      tools: args.tools,
      systemPrompt: args.systemPrompt,
      signal: args.signal,
      config: {
        callSite: COMPACTION_CALL_SITE,
        usageTracking: "manual",
        tool_choice: { type: "none" },
        ...(args.overrideProfile
          ? { overrideProfile: args.overrideProfile }
          : {}),
      },
    });
  } catch (err) {
    log.warn({ err }, "Compaction provider call failed");
    return {
      ...emptyResult(args, thresholdTokens, "provider error"),
      summaryFailed: true,
    };
  }

  // Persist the compaction LLM call into `llm_request_logs` with
  // `call_site = "compactionAgent"`. Non-fatal on DB error — see helper.
  recordCompactionRequestLog(args.conversationId, response, args.provider);

  const rawText = extractTextFromResponse(response.content);
  const parsed = parseCompactionResult(rawText);
  if (!parsed) {
    log.warn(
      { rawPreview: rawText.slice(0, 200) },
      "Compaction response did not contain a valid <compaction_result> block",
    );
    return {
      ...emptyResult(args, thresholdTokens, "unparseable response"),
      summaryFailed: false,
      summaryInputTokens: response.usage.inputTokens,
      summaryOutputTokens: response.usage.outputTokens,
      summaryModel: response.model,
      summaryCacheCreationInputTokens:
        response.usage.cacheCreationInputTokens ?? 0,
      summaryCacheReadInputTokens: response.usage.cacheReadInputTokens ?? 0,
      summaryCallSite: COMPACTION_CALL_SITE,
      summaryOverrideProfile: args.overrideProfile ?? null,
      summaryRawResponses: response.rawResponse ? [response.rawResponse] : [],
      summaryCalls: 1,
    };
  }

  const timestamps = buildTimestampIndex(args.messages);
  const resolvedTailIndex = resolveTailStartIndex(
    args.messages,
    timestamps,
    parsed,
  );
  if (resolvedTailIndex == null) {
    log.warn(
      {
        timestamp: parsed.tailStartTimestamp,
        preview: parsed.tailStartPreview.slice(0, 60),
      },
      "Compaction tail_start did not match any message — aborting compaction",
    );
    return {
      ...emptyResult(args, thresholdTokens, "tail_start unresolved"),
      summaryFailed: false,
      summaryInputTokens: response.usage.inputTokens,
      summaryOutputTokens: response.usage.outputTokens,
      summaryModel: response.model,
      summaryCacheCreationInputTokens:
        response.usage.cacheCreationInputTokens ?? 0,
      summaryCacheReadInputTokens: response.usage.cacheReadInputTokens ?? 0,
      summaryCallSite: COMPACTION_CALL_SITE,
      summaryOverrideProfile: args.overrideProfile ?? null,
      summaryRawResponses: response.rawResponse ? [response.rawResponse] : [],
      summaryCalls: 1,
    };
  }

  const pairedTailIndex = adjustTailIndexForToolPairing(
    args.messages,
    resolvedTailIndex,
  );
  if (pairedTailIndex !== resolvedTailIndex) {
    log.info(
      {
        conversationId: args.conversationId,
        originalTailIndex: resolvedTailIndex,
        tailIndex: pairedTailIndex,
        walkedBy: resolvedTailIndex - pairedTailIndex,
      },
      "Adjusted compaction tail backward to preserve tool_use/tool_result pairing",
    );
  }

  const summaryText = buildSummaryMemoryText(parsed.summary, parsed.keyState);
  // The durable summary. When the forward-cut below advances the tail, a
  // truncation notice is appended HERE — not just on the in-memory message —
  // because `applyCompactionResult` persists and rehydrates the summary from
  // the result's `summaryText`: a notice only on the message would vanish on
  // reload/fork, silently hiding that the dropped span was never summarized.
  let finalSummaryText = summaryText;
  let summaryMessage: Message = {
    role: "assistant",
    content: [{ type: "text", text: finalSummaryText }],
  };

  if (!retainImages && parsed.retainedImageFilenames.length > 0) {
    // Belt to the empty-manifest suspenders: the model may still emit a
    // `<retained_images>` block (e.g. hallucinated filenames). Never hydrate
    // for a text-only model.
    log.warn(
      { filenames: parsed.retainedImageFilenames },
      "Compaction requested image retention but the active model does not accept image input — dropping",
    );
  }
  const {
    blocks: retainedImageBlocks,
    resolved,
    missing,
  } = buildRetainedImageBlocks(
    retainImages ? parsed.retainedImageFilenames : [],
    manifest,
  );
  if (missing.length > 0) {
    log.warn(
      { missing },
      "Compaction referenced images that could not be resolved against attachments — dropping",
    );
  }

  const retainedImageMessage: Message | null =
    retainedImageBlocks.length > 0
      ? {
          role: "user",
          content: [
            {
              type: "text" as const,
              text: "Images retained from the compacted portion of the conversation:",
            },
            ...retainedImageBlocks,
          ],
        }
      : null;

  // Deterministic low-watermark enforcement. The model was asked to keep the
  // tail within the budget, but it routinely keeps a fat tail in repetitive
  // conversations, so each pass would otherwise free almost nothing and the
  // history bounces back over the trigger within a tick or two. When the
  // rebuilt history (summary + retained images + verbatim tail) still exceeds
  // `targetTokens`, advance the cut forward — onto clean user-turn boundaries
  // only — until it fits or the most-recent-complete-exchange floor is hit.
  // No second LLM call: the summary stays as written, and the span dropped
  // between the model's cut and the enforced cut is acknowledged with an
  // explicit truncation notice appended to the summary message (see below),
  // so the loss is visible in-context rather than silent.
  let tailIndex = pairedTailIndex;
  // Whether the deterministic forward-cut hit the tail floor while still over
  // `targetTokens` — propagated onto the success result so the window-manager's
  // retry loop can skip a futile second full-context pass (the floor is the same
  // next time, so it cannot do better). Only meaningful when a `targetTokens`
  // budget drove the forward-cut.
  let tailFloorReached = false;
  if (args.targetTokens != null && pairedTailIndex > 0) {
    const providerName =
      args.provider.tokenEstimationProvider ?? args.provider.name;
    // Mirror the window-manager's post-compaction estimate (system prompt +
    // tools + messages) so the forward-cut targets the same number the manager
    // recomputes on return — otherwise the cut would under-count by the tool
    // budget and land short of the real low-watermark.
    const toolTokenBudget = args.tools ? estimateToolsTokens(args.tools) : 0;
    const fixedPrefix: Message[] = [summaryMessage];
    if (retainedImageMessage) fixedPrefix.push(retainedImageMessage);
    const estimateRebuilt = (tail: Message[]): number =>
      estimatePromptTokens(
        [...fixedPrefix, ...stripInjectionsForCompaction(tail)],
        args.systemPrompt,
        { providerName, toolTokenBudget },
      );
    const floorIndex = resolveTailFloorIndex(args.messages, pairedTailIndex);
    const advanced = advanceTailForBudget({
      messages: args.messages,
      startIndex: pairedTailIndex,
      floorIndex,
      targetTokens: args.targetTokens,
      estimateTail: estimateRebuilt,
    });
    tailFloorReached = advanced.tailFloorReached;
    if (advanced.index !== pairedTailIndex) {
      tailIndex = advanced.index;
      // The LLM wrote its summary believing the verbatim tail would start at
      // `pairedTailIndex`, so the messages in [pairedTailIndex, tailIndex) are
      // covered by neither the summary's detail nor the retained tail. Append
      // a deterministic truncation notice so the loss is visible in-context
      // instead of silent — the conversation can recompute or recall what it
      // needs rather than acting on a gap it doesn't know exists. The notice
      // is a few dozen tokens against a multi-thousand-token target, so the
      // budget estimate above remains effectively accurate.
      const dropped = args.messages.slice(pairedTailIndex, tailIndex);
      const droppedUser = dropped.filter((m) => m.role === "user").length;
      const droppedAssistant = dropped.length - droppedUser;
      const truncationNote =
        `\n\n[Context budget enforcement: ${dropped.length} message(s) ` +
        `(${droppedUser} user, ${droppedAssistant} assistant) between this ` +
        `summary and the retained tail were truncated to fit the context ` +
        `budget and are not covered in detail above.]`;
      finalSummaryText = summaryText + truncationNote;
      summaryMessage = {
        role: "assistant",
        content: [{ type: "text", text: finalSummaryText }],
      };
      log.info(
        {
          conversationId: args.conversationId,
          modelTailIndex: pairedTailIndex,
          tailIndex,
          floorIndex,
          droppedFromTail: dropped.length,
          targetTokens: args.targetTokens,
          tailFloorReached,
        },
        "Advanced compaction tail forward to meet low-watermark token budget",
      );
    }
  }

  if (tailIndex === 0) {
    return {
      ...emptyResult(
        args,
        thresholdTokens,
        "tail_start at head — nothing to compact",
      ),
      summaryFailed: false,
      summaryInputTokens: response.usage.inputTokens,
      summaryOutputTokens: response.usage.outputTokens,
      summaryModel: response.model,
      summaryCacheCreationInputTokens:
        response.usage.cacheCreationInputTokens ?? 0,
      summaryCacheReadInputTokens: response.usage.cacheReadInputTokens ?? 0,
      summaryCallSite: COMPACTION_CALL_SITE,
      summaryOverrideProfile: args.overrideProfile ?? null,
      summaryRawResponses: response.rawResponse ? [response.rawResponse] : [],
      summaryCalls: 1,
    };
  }

  const compactableMessages = args.messages.slice(0, tailIndex);
  // Strip runtime injections from preserved tail messages before they land in
  // the compacted history. The static blocks (NOW.md, PKB, v2 essentials/
  // threads/recent/buffer, system reminders) on the tail are stale snapshots
  // from the moment of capture — keeping them would (a) waste tokens on
  // outdated content, (b) duplicate against the freshly re-injected blocks
  // the next turn produces, and (c) leak `<system_reminder>` text the model
  // is not supposed to see in history. `<turn_context>` is intentionally
  // preserved by `RUNTIME_INJECTION_PREFIXES`.
  const tailMessages = stripInjectionsForCompaction(
    args.messages.slice(tailIndex),
  );

  const compactedMessages: Message[] = [summaryMessage];
  if (retainedImageMessage) compactedMessages.push(retainedImageMessage);
  compactedMessages.push(...tailMessages);

  const nonPersistedCompactedAway = Math.min(
    args.nonPersistedPrefixCount ?? 0,
    compactableMessages.length,
  );
  const compactedPersistedMessages = Math.max(
    0,
    compactableMessages.length - nonPersistedCompactedAway,
  );

  log.info(
    {
      conversationId: args.conversationId,
      compactedMessages: compactableMessages.length,
      compactedPersistedMessages,
      tailIndex,
      ...(tailIndex !== resolvedTailIndex
        ? { originalTailIndex: resolvedTailIndex }
        : {}),
      retainedImages: resolved.length,
      summaryChars: finalSummaryText.length,
    },
    "Applied assistant-driven compaction",
  );

  return {
    messages: compactedMessages,
    compacted: true,
    previousEstimatedInputTokens: args.previousEstimatedInputTokens,
    // We don't re-estimate here — the caller (window manager) will recompute
    // when it returns to the agent loop. Returning the previous estimate is
    // a conservative placeholder.
    estimatedInputTokens: args.previousEstimatedInputTokens,
    maxInputTokens: args.maxInputTokens,
    thresholdTokens,
    compactedMessages: compactableMessages.length,
    compactedPersistedMessages,
    preservedTailMessages: args.messages.length - tailIndex,
    summaryCalls: 1,
    summaryInputTokens: response.usage.inputTokens,
    summaryOutputTokens: response.usage.outputTokens,
    summaryModel: response.model,
    summaryCallSite: COMPACTION_CALL_SITE,
    summaryOverrideProfile: args.overrideProfile ?? null,
    summaryCacheCreationInputTokens:
      response.usage.cacheCreationInputTokens ?? 0,
    summaryCacheReadInputTokens: response.usage.cacheReadInputTokens ?? 0,
    summaryRawResponses: response.rawResponse ? [response.rawResponse] : [],
    summaryText: finalSummaryText,
    keyState: parsed.keyState,
    summaryFailed: false,
    tailFloorReached,
  };
}

// ---------------------------------------------------------------------------
// Emergency mid-turn compaction
// ---------------------------------------------------------------------------

/**
 * Simplified instruction for emergency compaction. No `tail_start` or
 * `retained_images` — the caller already knows the split point. The model
 * just needs to produce a summary + key_state.
 */
const EMERGENCY_COMPACTION_PROMPT = `<emergency_compaction>
The conversation has exceeded the context window during an active task.
This is an emergency compaction — summarize EVERYTHING you see into a
fresh-start summary so the assistant can continue its work.

Write the summary in YOUR voice. Prioritize:
- What task is currently in progress and what stage it is at
- Decisions already made during this task
- Key results from tool calls that are still relevant
- Any commitments or state changes from earlier in the conversation
- What the next step should be

Be thorough on task state — this summary plus the most recent tool call
and its result are the ONLY context the assistant will have to continue.

Output your result in this exact format:

<compaction_result>
<summary>
Your complete summary of everything that happened.
</summary>

<key_state>
Structured list of:
- Current task and its status
- Important intermediate results
- What to do next
</key_state>
</compaction_result>
</emergency_compaction>`;

/**
 * Find the start index of the last tool_use + tool_result cluster in the
 * message array. Walks backwards to find the last assistant message
 * containing a `tool_use` content block, then returns that index. The
 * caller keeps everything from this index onwards as the preserved tail.
 *
 * Returns `null` if no tool_use message is found.
 */
function findLastToolPairStart(messages: Message[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const hasToolUse = msg.content.some((b) => b.type === "tool_use");
    if (hasToolUse) return i;
  }
  return null;
}

/**
 * Emergency compaction for the mid-turn context overflow case.
 *
 * When a `context_too_large` error fires during an active agent turn,
 * the normal compactor may itself exceed the context window (the
 * conversation that needs compacting is, by definition, too large to
 * send to the model as-is).
 *
 * This function:
 *   1. Finds the last tool_use message + its trailing tool_result(s)
 *   2. Splits the history there
 *   3. Truncates the prefix from the front if it exceeds the model's
 *      context window
 *   4. Sends the (possibly truncated) prefix to the model with a
 *      simplified emergency instruction
 *   5. Returns `[summary_message, ...last_tool_pair]` so the agent
 *      can continue with knowledge of what it just did
 *
 * If the provider call fails or no tool pair is found, returns
 * `compacted: false` so the caller can fall through to other
 * recovery strategies (tool-result truncation, media stubbing, etc.).
 */
export async function runEmergencyCompaction(
  args: CompactionRunArgs,
): Promise<CompactionRunResult> {
  const thresholdTokens = Math.floor(
    args.maxInputTokens * args.compaction.autoThreshold,
  );

  const splitIndex = findLastToolPairStart(args.messages);
  if (splitIndex == null || splitIndex === 0) {
    log.info("Emergency compaction: no tool pair found — falling through");
    return emptyResult(
      args,
      thresholdTokens,
      "no tool pair for emergency split",
    );
  }

  const keptTail = stripInjectionsForCompaction(
    args.messages.slice(splitIndex),
  );
  // Bound the prefix to the context window so the summary call fits, reserving
  // budget for the instruction message and the emitted summary. Truncates from
  // the front, keeping the recent portion the summary most needs. The prefix
  // is sliced from the sanitized projection (sanitize-then-slice, matching the
  // agent's own sends byte-for-byte for cache alignment) so the budget
  // estimate counts what the request actually carries. All sanitize
  // transforms are 1:1 per message, so `splitIndex` maps onto the sanitized
  // array unchanged.
  const prefix = truncateHistoryToBudget({
    messages: preModelCallSanitize(args.messages).slice(0, splitIndex),
    systemPrompt: args.systemPrompt,
    budgetTokens: compactionPrefixBudget(args.maxInputTokens),
    providerName: args.provider.tokenEstimationProvider ?? args.provider.name,
  });

  const instruction: Message = {
    role: "user",
    content: [{ type: "text", text: EMERGENCY_COMPACTION_PROMPT }],
  };
  const requestMessages = buildCompactionRequest(prefix, instruction);

  let response: ProviderResponse;
  try {
    response = await args.provider.sendMessage(requestMessages, {
      // See the assistant-driven path: tools keep the prefix cache warm, but
      // `tool_choice: "none"` forces a text-only `<compaction_result>` so the
      // model can't stall compaction by emitting an uncompletable tool call.
      tools: args.tools,
      systemPrompt: args.systemPrompt,
      signal: args.signal,
      config: {
        callSite: COMPACTION_CALL_SITE,
        usageTracking: "manual",
        tool_choice: { type: "none" },
        ...(args.overrideProfile
          ? { overrideProfile: args.overrideProfile }
          : {}),
      },
    });
  } catch (err) {
    log.warn({ err }, "Emergency compaction provider call failed");
    return {
      ...emptyResult(args, thresholdTokens, "emergency provider error"),
      summaryFailed: true,
    };
  }

  // Persist the emergency compaction LLM call into `llm_request_logs` with
  // `call_site = "compactionAgent"`. Non-fatal on DB error — see helper.
  recordCompactionRequestLog(args.conversationId, response, args.provider);

  const rawText = extractTextFromResponse(response.content);
  const parsed = parseCompactionResult(rawText);
  if (!parsed) {
    log.warn(
      { rawPreview: rawText.slice(0, 200) },
      "Emergency compaction response did not contain a valid <compaction_result>",
    );
    return {
      ...emptyResult(args, thresholdTokens, "emergency unparseable response"),
      summaryFailed: false,
      summaryCalls: 1,
      summaryInputTokens: response.usage.inputTokens,
      summaryOutputTokens: response.usage.outputTokens,
      summaryModel: response.model,
    };
  }

  const summaryText = buildSummaryMemoryText(parsed.summary, parsed.keyState);
  const summaryMessage: Message = {
    role: "assistant",
    content: [{ type: "text", text: summaryText }],
  };

  const compactedMessages: Message[] = [summaryMessage, ...keptTail];

  const compactedCount = splitIndex;
  const nonPersistedAway = Math.min(
    args.nonPersistedPrefixCount ?? 0,
    compactedCount,
  );

  log.info(
    {
      conversationId: args.conversationId,
      compactedMessages: compactedCount,
      keptTailMessages: keptTail.length,
      summaryChars: summaryText.length,
      prefixTruncated:
        prefix[0]?.content?.[0]?.type === "text" &&
        (prefix[0].content[0] as { text: string }).text.includes("truncated"),
    },
    "Applied emergency mid-turn compaction",
  );

  return {
    messages: compactedMessages,
    compacted: true,
    previousEstimatedInputTokens: args.previousEstimatedInputTokens,
    estimatedInputTokens: args.previousEstimatedInputTokens,
    maxInputTokens: args.maxInputTokens,
    thresholdTokens,
    compactedMessages: compactedCount,
    compactedPersistedMessages: Math.max(0, compactedCount - nonPersistedAway),
    preservedTailMessages: keptTail.length,
    summaryCalls: 1,
    summaryInputTokens: response.usage.inputTokens,
    summaryOutputTokens: response.usage.outputTokens,
    summaryModel: response.model,
    summaryCallSite: COMPACTION_CALL_SITE,
    summaryOverrideProfile: args.overrideProfile ?? null,
    summaryCacheCreationInputTokens:
      response.usage.cacheCreationInputTokens ?? 0,
    summaryCacheReadInputTokens: response.usage.cacheReadInputTokens ?? 0,
    summaryRawResponses: response.rawResponse ? [response.rawResponse] : [],
    summaryText,
    keyState: parsed.keyState,
    summaryFailed: false,
  };
}
