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
import type { CompactionConfig } from "../config/schemas/compaction.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { stripInjectionsForCompaction } from "../daemon/conversation-runtime-assembly.js";
import {
  getAttachmentContent,
  getAttachmentMetadataForMessage,
} from "../memory/attachments-store.js";
import { getMessages } from "../memory/conversation-crud.js";
import type {
  ContentBlock,
  ImageContent,
  Message,
  Provider,
  ProviderResponse,
  ToolDefinition,
} from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { estimatePromptTokens } from "./token-estimator.js";

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
- When in doubt, preserve more rather than less
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
  /** Pre-computed estimated input tokens for the live history. */
  previousEstimatedInputTokens: number;
  /** Skip the autoThreshold check — fire compaction unconditionally. */
  force?: boolean;
  signal?: AbortSignal;
  overrideProfile?: string | null;
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
 */
export function collectImageManifest(conversationId: string): ManifestEntry[] {
  const rows = getMessages(conversationId);
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
): Message {
  const template =
    customPrompt && customPrompt.trim().length > 0
      ? customPrompt
      : DEFAULT_COMPACTION_PROMPT;
  const text = template.replace("{image_manifest}", imageManifest);
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

  // Build image manifest from the DB before invoking the model so the
  // instruction message carries a faithful picture of available images.
  const manifest = collectImageManifest(args.conversationId);
  const manifestText = renderImageManifest(manifest);
  const instruction = buildInstructionMessage(
    args.compaction.prompt ?? null,
    manifestText,
  );

  // Append instruction at the tail — prefix unchanged, so prefix cache
  // stays warm.
  const requestMessages = [...args.messages, instruction];

  let response: ProviderResponse;
  try {
    response = await args.provider.sendMessage(
      requestMessages,
      args.tools,
      args.systemPrompt,
      {
        signal: args.signal,
        config: {
          callSite: COMPACTION_CALL_SITE,
          usageTracking: "manual",
          ...(args.overrideProfile
            ? { overrideProfile: args.overrideProfile }
            : {}),
        },
      },
    );
  } catch (err) {
    log.warn({ err }, "Compaction provider call failed");
    return {
      ...emptyResult(args, thresholdTokens, "provider error"),
      summaryFailed: true,
    };
  }

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

  const tailIndex = adjustTailIndexForToolPairing(
    args.messages,
    resolvedTailIndex,
  );
  if (tailIndex !== resolvedTailIndex) {
    log.info(
      {
        conversationId: args.conversationId,
        originalTailIndex: resolvedTailIndex,
        tailIndex,
        walkedBy: resolvedTailIndex - tailIndex,
      },
      "Adjusted compaction tail backward to preserve tool_use/tool_result pairing",
    );
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
  // is not supposed to see in history. `<turn_context>` and `<workspace>`
  // are intentionally preserved by `RUNTIME_INJECTION_PREFIXES`.
  const tailMessages = stripInjectionsForCompaction(
    args.messages.slice(tailIndex),
  );

  const summaryText = buildSummaryMemoryText(parsed.summary, parsed.keyState);
  const summaryMessage: Message = {
    role: "assistant",
    content: [{ type: "text", text: summaryText }],
  };

  const {
    blocks: retainedImageBlocks,
    resolved,
    missing,
  } = buildRetainedImageBlocks(parsed.retainedImageFilenames, manifest);
  if (missing.length > 0) {
    log.warn(
      { missing },
      "Compaction referenced images that could not be resolved against attachments — dropping",
    );
  }

  const compactedMessages: Message[] = [summaryMessage];
  if (retainedImageBlocks.length > 0) {
    compactedMessages.push({
      role: "user",
      content: [
        {
          type: "text" as const,
          text: "Images retained from the compacted portion of the conversation:",
        },
        ...retainedImageBlocks,
      ],
    });
  }
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
      summaryChars: summaryText.length,
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
    summaryText,
    keyState: parsed.keyState,
    summaryFailed: false,
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
  let prefix = args.messages.slice(0, splitIndex);

  // If the prefix itself exceeds the context window, truncate messages
  // from the front so the model can at least see the recent portion.
  // Reserve budget for the instruction message + output.
  const instructionBudget = 800; // ~tokens for the emergency prompt
  const outputBudget = Math.floor(args.maxInputTokens * 0.15);
  const prefixBudget = args.maxInputTokens - instructionBudget - outputBudget;

  let prefixEstimate = estimatePromptTokens(prefix, args.systemPrompt, {
    providerName: args.provider.tokenEstimationProvider ?? args.provider.name,
  });

  if (prefixEstimate > prefixBudget && prefix.length > 1) {
    log.info(
      {
        prefixEstimate,
        prefixBudget,
        prefixMessages: prefix.length,
      },
      "Emergency compaction: prefix exceeds context window — truncating from front",
    );
    // Drop messages from the front until we fit. Keep at least the first
    // message (may be an existing summary) and try to preserve recent context.
    let dropCount = 0;
    while (prefixEstimate > prefixBudget && dropCount < prefix.length - 1) {
      dropCount++;
      const truncated = prefix.slice(dropCount);
      prefixEstimate = estimatePromptTokens(truncated, args.systemPrompt, {
        providerName:
          args.provider.tokenEstimationProvider ?? args.provider.name,
      });
    }
    if (dropCount > 0) {
      prefix = [
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: `[${dropCount} earlier messages truncated — summary covers only the visible portion]`,
            },
          ],
        },
        ...prefix.slice(dropCount),
      ];
    }
  }

  const instruction: Message = {
    role: "user",
    content: [{ type: "text", text: EMERGENCY_COMPACTION_PROMPT }],
  };
  const requestMessages = [...prefix, instruction];

  let response: ProviderResponse;
  try {
    response = await args.provider.sendMessage(
      requestMessages,
      args.tools,
      args.systemPrompt,
      {
        signal: args.signal,
        config: {
          callSite: COMPACTION_CALL_SITE,
          usageTracking: "manual",
          ...(args.overrideProfile
            ? { overrideProfile: args.overrideProfile }
            : {}),
        },
      },
    );
  } catch (err) {
    log.warn({ err }, "Emergency compaction provider call failed");
    return {
      ...emptyResult(args, thresholdTokens, "emergency provider error"),
      summaryFailed: true,
    };
  }

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
