/**
 * Pure breakpoint-map logic for the Prompt tab. Walks an Anthropic
 * request payload in the order the provider matches its prompt cache —
 * tools → system → messages — and splits it into the ordered segments
 * delimited by the `cache_control` markers the client stamps onto the
 * request. Each segment carries an estimated token size and whether it
 * was served from cache or re-created this turn, so a reader can see
 * exactly where the cache boundaries fell and which part of the prefix
 * busted.
 *
 * Two values are unavoidably approximate and labelled as such by the
 * card: per-segment token counts (the web app has no tokenizer, so they
 * are estimated from text length) and, when a call both read and created
 * cache, the read/created split point (attributed by relative segment
 * size — the provider only reports the read and created totals, not a
 * per-segment breakdown). The read prefix always ends on a real
 * breakpoint, so the split is reported at a segment boundary.
 *
 * This module is side-effect free so it can be unit-tested in isolation;
 * the {@link CacheBreakpointMapCard} component owns all data fetching and
 * presentation.
 */

import type { LLMCallSummary } from "@vellumai/assistant-api";

/** Where a segment sits in the provider's cache prefix order. */
export type CacheSegmentRegion = "tools" | "system" | "messages";

/**
 * Whether a segment was served from cache (`read`), written to cache this
 * turn (`created`), or could not be classified because the call reported
 * no cache counters (`unknown`).
 */
export type CacheSegmentStatus = "read" | "created" | "unknown";

export interface CacheBreakpointSegment {
  key: string;
  /** Headline name, e.g. "Tools", "System block 1", "User message #3". */
  label: string;
  /** Optional secondary line describing absorbed content, or null. */
  detail: string | null;
  region: CacheSegmentRegion;
  /** Best per-segment token estimate (scaled to the real total when known). */
  estimatedTokens: number;
  /** `cache_control` TTL on the closing breakpoint (e.g. "1h", "5m"), or null. */
  ttl: string | null;
  status: CacheSegmentStatus;
}

export interface CacheBreakpointMap {
  /** Cache segments in prefix order; empty when caching was disabled. */
  segments: CacheBreakpointSegment[];
  readTokens: number | null;
  createdTokens: number | null;
  /** Sum of the per-segment estimates across the cacheable prefix. */
  estimatedPrefixTokens: number;
  /** True when the read/created split was attributed by segment size. */
  splitEstimated: boolean;
}

/** Rough characters-per-token ratio for English prose and JSON. */
const CHARS_PER_TOKEN = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function estimateTokens(charCount: number): number {
  return Math.max(0, Math.round(charCount / CHARS_PER_TOKEN));
}

function jsonCharCount(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** The closing breakpoint's TTL when a block carries `cache_control`, else null. */
function cacheControlTtl(block: Record<string, unknown>): {
  present: boolean;
  ttl: string | null;
} {
  const control = block.cache_control;
  if (!isRecord(control)) {
    return { present: false, ttl: null };
  }
  return { present: true, ttl: asString(control.ttl) ?? null };
}

function capitalize(text: string): string {
  return text.length > 0 ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

/**
 * One contiguous chunk of the request prefix. `hasBreakpoint` marks the
 * chunks that carry a `cache_control` marker and therefore close a cache
 * segment; `summary` is a count detail surfaced when the chunk is the
 * only one in its segment (e.g. the tool count).
 */
interface PrefixPart {
  region: CacheSegmentRegion;
  title: string;
  summary: string | null;
  estimatedTokens: number;
  hasBreakpoint: boolean;
  ttl: string | null;
}

function toolsPart(tools: unknown[]): PrefixPart {
  // The cache breakpoint is not always on the final tool: with native web
  // search the provider appends a server tool after the cached client
  // tools, leaving the `cache_control` marker on an earlier entry. Scan the
  // whole list so the Tools segment still closes at the real boundary.
  let hasBreakpoint = false;
  let ttl: string | null = null;
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }
    const control = cacheControlTtl(tool);
    if (control.present) {
      hasBreakpoint = true;
      ttl = control.ttl;
    }
  }
  return {
    region: "tools",
    title: "Tools",
    summary: `${tools.length} tool ${tools.length === 1 ? "definition" : "definitions"}`,
    estimatedTokens: estimateTokens(jsonCharCount(tools)),
    hasBreakpoint,
    ttl,
  };
}

function systemParts(system: unknown): PrefixPart[] {
  if (typeof system === "string") {
    return [
      {
        region: "system",
        title: "System prompt",
        summary: null,
        estimatedTokens: estimateTokens(system.length),
        hasBreakpoint: false,
        ttl: null,
      },
    ];
  }

  const blocks = (asArray(system) ?? []).filter(isRecord);
  return blocks.map((block, index) => {
    const control = cacheControlTtl(block);
    return {
      region: "system",
      title: blocks.length > 1 ? `System block ${index + 1}` : "System prompt",
      summary: null,
      estimatedTokens: estimateTokens((asString(block.text) ?? "").length),
      hasBreakpoint: control.present,
      ttl: control.ttl,
    };
  });
}

function messageBlockCharCount(block: Record<string, unknown>): number {
  const text = asString(block.text);
  return text != null ? text.length : jsonCharCount(block);
}

/**
 * A contiguous run of a message's content blocks ending either at a block
 * that carries `cache_control` (a breakpoint) or at the end of the message.
 */
interface MessageChunk {
  estimatedTokens: number;
  hasBreakpoint: boolean;
  ttl: string | null;
  /** 1-based index of the last content block in the chunk. */
  lastBlockNumber: number;
}

/**
 * Splits a message into chunks at every `cache_control` marker. A single
 * message can carry more than one breakpoint — a caller-stamped stable
 * block plus the client's own turn-start anchor on the last block — so each
 * marker has to close its own segment instead of collapsing the whole
 * message into one.
 */
function messageChunks(content: unknown): MessageChunk[] {
  if (typeof content === "string") {
    return [
      {
        estimatedTokens: estimateTokens(content.length),
        hasBreakpoint: false,
        ttl: null,
        lastBlockNumber: 1,
      },
    ];
  }

  const blocks = (asArray(content) ?? []).filter(isRecord);
  const chunks: MessageChunk[] = [];
  let charCount = 0;

  blocks.forEach((block, blockIndex) => {
    charCount += messageBlockCharCount(block);
    const control = cacheControlTtl(block);
    if (control.present) {
      chunks.push({
        estimatedTokens: estimateTokens(charCount),
        hasBreakpoint: true,
        ttl: control.ttl,
        lastBlockNumber: blockIndex + 1,
      });
      charCount = 0;
    }
  });

  if (charCount > 0 || chunks.length === 0) {
    chunks.push({
      estimatedTokens: estimateTokens(charCount),
      hasBreakpoint: false,
      ttl: null,
      lastBlockNumber: blocks.length,
    });
  }

  return chunks;
}

function messageParts(
  message: Record<string, unknown>,
  index: number,
): PrefixPart[] {
  const role = asString(message.role) ?? "message";
  const label = `${capitalize(role)} message #${index + 1}`;
  const chunks = messageChunks(message.content);
  return chunks.map((chunk) => ({
    region: "messages",
    title: chunks.length > 1 ? `${label} · block ${chunk.lastBlockNumber}` : label,
    summary: null,
    estimatedTokens: chunk.estimatedTokens,
    hasBreakpoint: chunk.hasBreakpoint,
    ttl: chunk.ttl,
  }));
}

function buildPrefixParts(request: Record<string, unknown>): PrefixPart[] | null {
  const messages = asArray(request.messages);
  if (!messages) {
    return null;
  }

  const parts: PrefixPart[] = [];

  const tools = asArray(request.tools);
  if (tools && tools.length > 0) {
    parts.push(toolsPart(tools));
  }

  if (request.system !== undefined) {
    parts.push(...systemParts(request.system));
  }

  messages.forEach((message, index) => {
    if (isRecord(message)) {
      parts.push(...messageParts(message, index));
    }
  });

  return parts;
}

function segmentDetail(parts: PrefixPart[]): string | null {
  const leading = parts.slice(0, -1);
  const terminal = parts[parts.length - 1];
  if (leading.length === 0) {
    return terminal.summary;
  }
  if (leading.length <= 2) {
    return `Includes ${leading.map((part) => part.title).join(", ")}`;
  }
  return `Includes ${leading.length} earlier blocks`;
}

function groupIntoSegments(parts: PrefixPart[]): CacheBreakpointSegment[] {
  const segments: CacheBreakpointSegment[] = [];
  let pending: PrefixPart[] = [];

  for (const part of parts) {
    pending.push(part);
    if (!part.hasBreakpoint) {
      continue;
    }
    segments.push({
      key: `segment-${segments.length}`,
      label: part.title,
      detail: segmentDetail(pending),
      region: part.region,
      estimatedTokens: pending.reduce((sum, p) => sum + p.estimatedTokens, 0),
      ttl: part.ttl,
      status: "unknown",
    });
    pending = [];
  }

  return segments;
}

/**
 * Classifies each segment as read or created and returns the adjusted
 * segments plus whether the split point was estimated. When both read and
 * created tokens are reported, the boundary is placed at the segment
 * boundary whose cumulative (size-scaled) tokens fall closest to the read
 * total, and segment estimates are rescaled to sum to the real cacheable
 * total so the displayed numbers stay anchored to the provider's counts.
 */
function classifySegments(
  segments: CacheBreakpointSegment[],
  readTokens: number | null,
  createdTokens: number | null,
): { segments: CacheBreakpointSegment[]; splitEstimated: boolean } {
  if (readTokens == null && createdTokens == null) {
    return { segments, splitEstimated: false };
  }

  const read = readTokens ?? 0;
  const created = createdTokens ?? 0;

  if (read <= 0) {
    return {
      segments: segments.map((segment) => ({ ...segment, status: "created" })),
      splitEstimated: false,
    };
  }
  if (created <= 0) {
    return {
      segments: segments.map((segment) => ({ ...segment, status: "read" })),
      splitEstimated: false,
    };
  }

  const total = read + created;
  const estimatedTotal =
    segments.reduce((sum, segment) => sum + segment.estimatedTokens, 0) || 1;
  const scale = total / estimatedTotal;

  let cumulative = 0;
  let boundary = 0;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= segments.length; index += 1) {
    const diff = Math.abs(cumulative - read);
    if (diff < bestDiff) {
      bestDiff = diff;
      boundary = index;
    }
    if (index < segments.length) {
      cumulative += segments[index].estimatedTokens * scale;
    }
  }

  return {
    segments: segments.map((segment, index) => ({
      ...segment,
      estimatedTokens: Math.round(segment.estimatedTokens * scale),
      status: index < boundary ? "read" : "created",
    })),
    splitEstimated: true,
  };
}

/**
 * Parses an Anthropic request payload into its cache-breakpoint map, or
 * returns null when the payload is not an Anthropic request (so callers
 * can drop the card in unconditionally). A non-null result with an empty
 * `segments` array means the request carried no `cache_control` markers —
 * prompt caching was disabled for the call.
 */
export function parseCacheBreakpoints(
  requestPayload: unknown,
  summary: LLMCallSummary | null | undefined,
): CacheBreakpointMap | null {
  if (!isRecord(requestPayload)) {
    return null;
  }

  const parts = buildPrefixParts(requestPayload);
  if (!parts || parts.length === 0) {
    return null;
  }

  const provider = summary?.provider?.toLowerCase();
  const model = asString(requestPayload.model);
  const looksAnthropic =
    provider === "anthropic" || (model?.startsWith("claude-") ?? false);
  const hasBreakpoint = parts.some((part) => part.hasBreakpoint);
  if (!looksAnthropic && !hasBreakpoint) {
    return null;
  }

  const grouped = groupIntoSegments(parts);
  const readTokens = finiteNumberOrNull(summary?.cacheReadInputTokens);
  const createdTokens = finiteNumberOrNull(summary?.cacheCreationInputTokens);
  const { segments, splitEstimated } = classifySegments(
    grouped,
    readTokens,
    createdTokens,
  );

  return {
    segments,
    readTokens,
    createdTokens,
    estimatedPrefixTokens: segments.reduce(
      (sum, segment) => sum + segment.estimatedTokens,
      0,
    ),
    splitEstimated,
  };
}
