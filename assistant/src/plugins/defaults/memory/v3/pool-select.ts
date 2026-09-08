/**
 * Memory v3 — single pool selector.
 *
 * Runs a SINGLE forced-tool call over one unified candidate pool rendered in
 * two segments that share one numbering:
 *
 *   1. STABLE PREFIX — the core+hot lane pages as FULL CARDS (head section +
 *      section TOC, see `card.ts`), numbered `[1]…[m]` in pool order. The
 *      cards are query- and conversation-state-independent, so the rendered
 *      segment is byte-identical across turns while the lanes are unchanged
 *      (lane invalidation at consolidation is the recompute cadence). It is
 *      emitted as its OWN content block carrying a `cache_control`
 *      breakpoint, so it rides the provider KV cache — block-level
 *      `cache_control` is preserved through `toAnthropicBlockSafe` (PR
 *      #33258; covered by the caller-stamped-block tests in
 *      `anthropic-provider.test.ts`).
 *   2. DYNAMIC TAIL — the per-turn finder candidates as compact numbered
 *      lines (`[m+1] <slug> — <matched-section snippet>`), then the
 *      situational/recent/current conversation context. Re-rendered every
 *      turn; never cached. `disableTurnStartCache` suppresses the provider's
 *      auto-applied 1h turn-start breakpoint, which would otherwise land on
 *      this per-turn-varying block and pay cache_creation with no future hit
 *      (same rationale as the v2 router).
 *
 * Candidate composition is deliberately conversation-state-independent:
 * already-injected pages are NOT filtered out of the pool — that would change
 * the stable prefix per conversation state and bust the cache. Re-selecting
 * an injected page is harmless (injection dedup happens downstream) and feeds
 * hot-set frecency + section injection. A page may appear BOTH as a
 * stable-prefix card and on finder lines, one per matched section (its
 * current relevance); selecting a finder line selects that section, and
 * selections are merged per slug with every selected section.
 *
 * Failure handling distinguishes a DELIBERATE empty selection from an
 * INFRASTRUCTURE failure — the two are different outcomes, not the same one:
 *   - explicit `ids` → select exactly those candidates,
 *   - explicit empty `ids: []` → select none (deliberate abstention) — a
 *     normal, non-error result; the turn proceeds,
 *   - omitted `ids` → keep ALL candidates (the recall-safe "all of these are
 *     relevant" signal),
 *   - empty candidate pool → return none (nothing to select),
 *   - infrastructure failure (selector provider unavailable — e.g. a transient
 *     CES credential blip drops the API key — or no usable `tool_use` / schema
 *     mismatch surviving the short re-prompt retry) → throw
 *     {@link MemoryV3RetrievalUnavailableError}. The live injector treats this
 *     as a logged memory miss for the turn; shadow/observation callers swallow
 *     it so v2 retrieval can serve the turn.
 */

import type {
  ContentBlock,
  Message,
  ToolUseContent,
} from "@vellumai/plugin-api";
import { getConfiguredProvider } from "@vellumai/plugin-api";
import { z } from "zod";

import { classifyConversationError } from "../../../../daemon/conversation-error.js";
import type { PendingConversationNotice } from "../../../../daemon/conversation-notices.js";
import { redactLogString, truncate } from "../host-utils.js";
import {
  cachedTextBlock,
  extractToolUse,
  type ToolDefinition,
} from "../llm-helpers.js";
import { getLogger } from "../logging.js";
import { loadPromptOverride } from "../prompt-override.js";
import { retryForResult } from "./llm-retry.js";
import { findTerm } from "./section-needle.js";
import { sectionBody } from "./sections.js";
import {
  type MemoryRoutingTurn,
  type Section,
  sectionKey,
  type SelectedPage,
  type Slug,
} from "./types.js";

const log = getLogger("memory-v3-pool-select");

/**
 * Thrown when the pool selector cannot produce a selection because of an
 * INFRASTRUCTURE failure — its LLM provider is unavailable (e.g. a transient
 * CES credential blip drops the API key), or no usable `tool_use` survives the
 * re-prompt retry. Deliberately DISTINCT from a deliberate empty selection
 * (`ids: []`) and an empty candidate pool, both of which return normally.
 *
 * The live memory-v3 injector logs this as a memory miss for the turn; the
 * shadow/observation path catches and swallows it.
 */
export class MemoryV3RetrievalUnavailableError extends Error {
  readonly conversationNotice?: PendingConversationNotice;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      conversationNotice?: PendingConversationNotice;
    },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "MemoryV3RetrievalUnavailableError";
    this.conversationNotice = options?.conversationNotice;
  }
}

function providerBillingNoticeFromError(
  error: unknown,
): PendingConversationNotice | undefined {
  const classified = classifyConversationError(error, {
    phase: "agent_loop",
  });
  if (classified.code !== "PROVIDER_BILLING") {
    return undefined;
  }
  return {
    source: "memory_v3",
    code: classified.code,
    userMessage: classified.userMessage,
    errorCategory: classified.errorCategory,
  };
}

/** A dynamic-tail (finder) candidate: the slug plus the descriptor that
 *  justifies it (a matched section's text for a needle/dense hit, or a
 *  curated link description for an edge page), rendered as a one-line
 *  snippet and prefixed with the surfacing lane when one is supplied. A
 *  candidate that also carries its matched `section` and the query `terms`
 *  that scored it (best first) renders a keyword-in-context snippet instead:
 *  a window of the section body around the first of those terms that occurs
 *  in it. A rare-term line (lane `rare`) is keyed on the one query word it
 *  carries as its only term and tags as `(rare: word)`. One page can appear
 *  on several lines, one per matched section; selecting a line selects that
 *  section. */
export interface PoolCandidate {
  slug: Slug;
  descriptor: string;
  lane?: string;
  section?: Section;
  terms?: string[];
}

/** A stable-prefix candidate: the slug plus its pre-rendered FULL card
 *  (`renderCard` output — head section + TOC). Cards must be byte-stable
 *  across turns for the prefix to ride the provider KV cache, which is why
 *  callers pre-render them at lane init rather than per turn. */
export interface StableCandidate {
  slug: Slug;
  card: string;
}

/**
 * The selector's unified candidate pool in cache order: the stable prefix
 * (core+hot cards) then the dynamic finder tail. The two segments share one
 * numbering — `[1]…[m]` cards, `[m+1]…` finder lines — and MAY repeat a slug
 * (a finder hit on a core/hot page keeps its matched-section line so the
 * page's CURRENT relevance stays visible, and a page hit on several sections
 * has one line per section); selections are merged per slug.
 */
export interface SelectorPool {
  stable: StableCandidate[];
  finder: PoolCandidate[];
}

/** Tool name forced via `tool_choice`. Shared constant so tests can match it. */
const SELECT_PAGES_TOOL_NAME = "select_pages";
const MEMORY_V3_SELECT_CALL_SITE = "memoryV3SelectL2" as const;

/** Finder-line snippets are truncated to keep the dynamic tail compact. */
const SNIPPET_MAX_CHARS = 300;
const ERROR_MESSAGE_MAX_CHARS = 500;

type PoolSelectorAttemptFailureReason =
  | "provider_error"
  | "missing_tool_use"
  | "unexpected_tool_name"
  | "schema_mismatch";

interface PoolSelectorAttemptFailure {
  attempt: number;
  reason: PoolSelectorAttemptFailureReason;
  callSite: typeof MEMORY_V3_SELECT_CALL_SITE;
  providerName: string;
  candidateCount: number;
  stableCount: number;
  finderCount: number;
  response?: {
    model: string;
    actualProvider?: string;
    stopReason: string;
    requestModel?: string;
    responseModel?: string;
    contentBlockTypes: string[];
    toolUseNames: string[];
  };
  error?: {
    name: string;
    message: string;
    provider?: string;
    statusCode?: number;
  };
  toolName?: string;
  schemaIssues?: Array<{ path: string; code: string }>;
}

const SelectPagesSchema = z.object({
  // Optional: an omitted `ids` field is the recall-safe "keep everything"
  // signal, distinct from an explicit empty array (deliberate abstention).
  ids: z.array(z.number().int()).optional(),
});

const SELECT_PAGES_TOOL: ToolDefinition = {
  name: SELECT_PAGES_TOOL_NAME,
  description:
    "Select the candidate pages whose content the reply would draw on. Lean " +
    "inclusive — when in doubt, keep a candidate; for a list or " +
    '"all of X" request keep every candidate that belongs. Omit `ids` only ' +
    "as a recall-safe fallback when you cannot judge the pool (keeps every " +
    "candidate); return `[]` when candidates are present but none are " +
    "relevant.",
  input_schema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "integer" },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are given the candidate memory pages for an assistant's next reply, in two segments that share one numbering: full page cards first (the curated core, recently-recurring, and recently-modified pages, shown every turn), then this turn's search hits as one-line snippets. Cards carry a \`[lane: …]\` annotation — core is curated, hot recurs by selection frequency, fresh was recently modified (with its last-update time) — and search hits are tagged with the lane that surfaced them.

A page can appear on several search-hit lines, one per matched section, each snippet showing the matched words in context; selecting a line selects that section, so keep every line whose section the reply would draw on. A line tagged \`(rare: word)\` means the message used a word that occurs in only a handful of sections and this is one of them, a strong signal on its own even when the rest of the message is about something else.

Select EVERY candidate whose content the upcoming reply would draw on. That includes facts the reply needs, current task and event state (open items, deadlines, schedules, recent activity), and equally register, established framing, calibration rules, and relationship/person/project texture — pages that shape HOW to reply, not only what to say. There is no limit on how many you may select; recall matters more than precision, so when a candidate could plausibly inform the reply, keep it. For a list or an "all of X" request, keep EVERY candidate that belongs to X rather than guessing a representative subset.

Pages you select persist in the conversation automatically, and re-selecting a page that is already in context is harmless (duplicates are removed downstream) — so never withhold a candidate because it might have been selected before. Judge each candidate only by whether the upcoming reply would draw on it.

A page can be relevant because of the current situation — the date or the live scratchpad — not only the message: keep a page the situation makes pertinent (e.g. a person whose anniversary is today). When the message asks about status, plans, schedule, or what's pending, treat pages carrying current task/event state — especially recently-updated (fresh) ones — as first-class candidates.

Call \`select_pages\` with the chosen IDs. Omit \`ids\` only as a recall-safe fallback when you cannot judge the pool (keeps every candidate); return \`[]\` when candidates are present but none are relevant.`;

/**
 * Resolve the selector system prompt: the file at `overridePath` when it is set
 * and usable, otherwise the bundled {@link SYSTEM_PROMPT}. Path resolution and
 * fallback follow the shared override loader (workspace-relative; a missing,
 * empty, oversized, or unreadable file degrades to the bundled prompt with a
 * warning). The selector prompt takes no placeholders — the candidate pool is
 * the user message — so an override file is used verbatim.
 */
export function resolveSelectorPrompt(
  overridePath: string | null,
  workspaceDir: string,
): string {
  return (
    loadPromptOverride({
      overridePath,
      workspaceDir,
      log,
      label: "memory-v3 selector prompt",
    }) ?? SYSTEM_PROMPT
  );
}

/** Collapse text to one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The keyword-in-context snippet of a candidate's matched section:
 * `§<title>: … <window> …`, the window being up to {@link SNIPPET_MAX_CHARS}
 * of the one-line section body centered on the first occurrence of the
 * best-contributing query term that occurs in it (the lead, titled `""`,
 * renders the window alone). `undefined` when no term occurs in the body.
 */
function renderKeywordInContext(
  section: Section,
  terms: string[],
): string | undefined {
  const body = oneLine(sectionBody(section));
  for (const term of terms) {
    const span = findTerm(body, term);
    if (!span) {
      continue;
    }
    const center = Math.floor((span.start + span.end) / 2);
    const start = Math.max(
      0,
      Math.min(
        center - Math.floor(SNIPPET_MAX_CHARS / 2),
        body.length - SNIPPET_MAX_CHARS,
      ),
    );
    const end = Math.min(body.length, start + SNIPPET_MAX_CHARS);
    const window = [
      start > 0 ? "… " : "",
      body.slice(start, end).trim(),
      end < body.length ? " …" : "",
    ].join("");
    const title = section.title.trim();
    return title.length > 0 ? `§${title}: ${window}` : window;
  }
  return undefined;
}

/** A finder candidate's one-line snippet: the keyword-in-context window when
 *  it carries a section and a query term that occurs in that section's body,
 *  otherwise its descriptor collapsed to one line and capped. */
function renderSnippet(candidate: PoolCandidate): string {
  const kwic =
    candidate.section && candidate.terms
      ? renderKeywordInContext(candidate.section, candidate.terms)
      : undefined;
  return kwic ?? truncate(oneLine(candidate.descriptor), SNIPPET_MAX_CHARS);
}

function readStringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function summarizeResponse(response: {
  model: string;
  actualProvider?: string;
  stopReason: string;
  rawRequest?: unknown;
  rawResponse?: unknown;
  content: ContentBlock[];
}): NonNullable<PoolSelectorAttemptFailure["response"]> {
  const requestModel = readStringField(response.rawRequest, "model");
  const responseModel = readStringField(response.rawResponse, "model");
  return {
    model: response.model,
    ...(response.actualProvider
      ? { actualProvider: response.actualProvider }
      : {}),
    stopReason: response.stopReason,
    ...(requestModel ? { requestModel } : {}),
    ...(responseModel ? { responseModel } : {}),
    contentBlockTypes: response.content.map((block) => block.type),
    toolUseNames: response.content
      .filter((block): block is ToolUseContent => block.type === "tool_use")
      .map((block) => block.name),
  };
}

function summarizeError(error: unknown): PoolSelectorAttemptFailure["error"] {
  const record =
    error !== null && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const name =
    error instanceof Error
      ? error.name
      : typeof record.name === "string"
        ? record.name
        : "Error";
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof record.message === "string"
        ? record.message
        : String(error);
  const provider =
    typeof record.provider === "string" ? record.provider : undefined;
  const statusCode =
    typeof record.statusCode === "number" ? record.statusCode : undefined;
  return {
    name,
    message: truncate(redactLogString(rawMessage), ERROR_MESSAGE_MAX_CHARS),
    ...(provider ? { provider } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  };
}

/**
 * Render the stable prefix: each core/hot card prefixed with its pool number.
 * Pure concatenation of pre-rendered cards — byte-identical across turns for
 * identical `stable` input, which is the cache contract.
 */
function renderCardSegment(stable: StableCandidate[]): string {
  const cards = stable.map((c, i) => `[${i + 1}] ${c.card}`);
  return `<candidate_cards>\n${cards.join("\n\n")}\n</candidate_cards>`;
}

/** A finder line's lane tag: `(lane) `, or `(rare: word) ` for a rare-term
 *  line, keyed on the one word it carries as its term; empty for a candidate
 *  without a lane. */
function laneTag(candidate: PoolCandidate): string {
  if (candidate.lane === undefined) {
    return "";
  }
  const word = candidate.lane === "rare" ? candidate.terms?.[0] : undefined;
  return word === undefined
    ? `(${candidate.lane}) `
    : `(${candidate.lane}: ${word}) `;
}

/**
 * Render the finder tail: one `[m+i] (lane) slug — snippet` line per
 * candidate, numbered continuing after the `offset` stable-prefix cards. The
 * lane tag is omitted for a candidate without one and names the keyed word
 * for a rare-term line (`(rare: turnip)`); a candidate with an empty
 * descriptor renders without the dash.
 */
function renderFinderSegment(finder: PoolCandidate[], offset: number): string {
  const lines = finder.map((c, i) => {
    const snippet = renderSnippet(c);
    const id = offset + i + 1;
    const lane = laneTag(c);
    return snippet.length > 0
      ? `[${id}] ${lane}${c.slug} — ${snippet}`
      : `[${id}] ${lane}${c.slug}`;
  });
  return `<candidates>\n${lines.join("\n")}\n</candidates>`;
}

/** One pool line as a selectable unit: a stable-prefix card (no section) or
 *  a finder line with the section it carries (none for a section-less edge
 *  or learned line). */
interface PoolLine {
  slug: Slug;
  section?: Section;
}

/** Every line in the pool's concatenated numbering: ids 1…m are the
 *  stable-prefix cards, ids m+1… are the finder lines. */
function orderedLines(pool: SelectorPool): PoolLine[] {
  return [
    ...pool.stable.map((c): PoolLine => ({ slug: c.slug })),
    ...pool.finder.map((c): PoolLine => ({ slug: c.slug, section: c.section })),
  ];
}

/**
 * Merge the picked lines (0-based indices into `lines`, in the order the
 * selector listed them) into pages: one per slug in first-picked order (a
 * page can be picked as a card and on several finder lines), each carrying
 * the sections of its picked finder lines in pool order, deduped by section
 * key. A card or a section-less line contributes no section.
 */
function mergeSelectedLines(
  lines: PoolLine[],
  picked: number[],
): SelectedPage[] {
  const pages = new Map<Slug, SelectedPage>();
  for (const index of picked) {
    const { slug } = lines[index]!;
    if (!pages.has(slug)) {
      pages.set(slug, { slug, sections: [] });
    }
  }
  for (const index of [...new Set(picked)].sort((a, c) => a - c)) {
    const { slug, section } = lines[index]!;
    const page = pages.get(slug)!;
    if (
      section &&
      !page.sections.some((s) => sectionKey(s) === sectionKey(section))
    ) {
      page.sections.push(section);
    }
  }
  return [...pages.values()];
}

/** Return every candidate in pool order, merged per slug. */
export function selectAllPoolCandidates(pool: SelectorPool): SelectedPage[] {
  const lines = orderedLines(pool);
  return mergeSelectedLines(
    lines,
    lines.map((_, index) => index),
  );
}

/** A selection plus whether it came from the recall-safe keep-all fallback. */
export interface PoolSelection {
  pages: SelectedPage[];
  /** True only when the model OMITTED `ids` and every candidate was kept as the
   *  recall-safe fallback — NOT when it explicitly selected a large set. The two
   *  produce the same pages but mean different things (the model gave up judging
   *  vs it judged everything relevant), and only telemetry can tell them apart. */
  keptAll: boolean;
}

/**
 * Run the single forced-tool selector over the unified candidate pool. Returns
 * the pages to inject, merged per slug (a page selected as a card and on
 * finder lines yields one entry carrying every selected section), plus a
 * `keptAll` flag marking the recall-safe fallback.
 *
 * An omitted `ids` keeps ALL candidates (the recall-safe "all of these are
 * relevant" signal, `keptAll: true`); an explicit `[]` keeps none; an
 * infrastructure failure (after a short re-prompt retry) keeps none, degrading
 * to the deterministic recall lanes the orchestrator unions in.
 *
 * `systemPrompt` is the selector's instruction scaffold; it defaults to the
 * bundled {@link SYSTEM_PROMPT} and is overridable via `memory.v3.selectorPromptPath`
 * (resolved by {@link resolveSelectorPrompt} at the call site).
 */
export async function selectPool(
  pool: SelectorPool,
  turn: MemoryRoutingTurn,
  systemPrompt: string = SYSTEM_PROMPT,
): Promise<PoolSelection> {
  const ordered = orderedLines(pool);
  if (ordered.length === 0) {
    return { pages: [], keptAll: false };
  }

  const provider = await getConfiguredProvider(MEMORY_V3_SELECT_CALL_SITE);
  if (!provider) {
    log.warn(
      {
        callSite: MEMORY_V3_SELECT_CALL_SITE,
        candidateCount: ordered.length,
        stableCount: pool.stable.length,
        finderCount: pool.finder.length,
      },
      "pool selector provider unavailable",
    );
    throw new MemoryV3RetrievalUnavailableError(
      "memory-v3 pool selector provider unavailable",
    );
  }

  // Two content blocks: the stable prefix (cards) carries the cache
  // breakpoint; the dynamic tail (finder lines + per-turn context) does not.
  // See the module doc for the cache contract.
  const content: ContentBlock[] = [];
  if (pool.stable.length > 0) {
    content.push(cachedTextBlock(renderCardSegment(pool.stable)));
  }
  const tailParts: string[] = [];
  if (pool.finder.length > 0) {
    tailParts.push(renderFinderSegment(pool.finder, pool.stable.length));
  }
  if (turn.situationalContext) {
    tailParts.push(`<situation>${turn.situationalContext}</situation>`);
  }
  tailParts.push(`<recent_context>${turn.recentContext}</recent_context>`);
  tailParts.push(`<current_message>${turn.currentMessage}</current_message>`);
  content.push({ type: "text", text: tailParts.join("\n") });

  const userMsg: Message = { role: "user", content };
  const failures: PoolSelectorAttemptFailure[] = [];
  let attempt = 0;
  const recordFailure = (
    failure: Omit<
      PoolSelectorAttemptFailure,
      | "callSite"
      | "providerName"
      | "candidateCount"
      | "stableCount"
      | "finderCount"
    >,
  ): void => {
    const diagnostic: PoolSelectorAttemptFailure = {
      ...failure,
      callSite: MEMORY_V3_SELECT_CALL_SITE,
      providerName: provider.name,
      candidateCount: ordered.length,
      stableCount: pool.stable.length,
      finderCount: pool.finder.length,
    };
    failures.push(diagnostic);
    log.warn(diagnostic, "pool selector attempt failed");
  };

  // One forced-tool call, retried a few times so a transient malformed response
  // (no usable tool_use, or tool input that fails the schema) re-prompts before
  // we give up. `null` from an attempt means "unusable, retry"; the provider
  // layer already backs off transient throws, so this loop adds no delay.
  //
  // `lastError` captures the most recent attempt's thrown provider error —
  // `retryForResult` swallows attempt throws, so without this an infrastructure
  // failure (e.g. an upstream HTTP 4xx/5xx) is indistinguishable from a 200 that
  // carried no usable tool_use. It is cleared on every attempt that reaches a
  // response, so it reflects the LAST attempt's failure mode.
  let lastError: unknown = null;
  const parsed = await retryForResult(async () => {
    attempt += 1;
    let response: Awaited<ReturnType<typeof provider.sendMessage>>;
    try {
      response = await provider.sendMessage([userMsg], {
        tools: [SELECT_PAGES_TOOL],
        systemPrompt,
        config: {
          callSite: MEMORY_V3_SELECT_CALL_SITE,
          conversationId: turn.conversationId,
          tool_choice: { type: "tool" as const, name: SELECT_PAGES_TOOL_NAME },
          // The last block of this one-shot message varies every turn; the
          // provider's auto-applied turn-start breakpoint would land on it and
          // pay cache_creation with no future hit. The stable-prefix block
          // above carries its own breakpoint instead.
          disableTurnStartCache: true,
        },
      });
      lastError = null;
    } catch (error) {
      lastError = error;
      recordFailure({
        attempt,
        reason: "provider_error",
        error: summarizeError(error),
      });
      throw error;
    }
    const toolBlock = extractToolUse(response);
    if (!toolBlock) {
      recordFailure({
        attempt,
        reason: "missing_tool_use",
        response: summarizeResponse(response),
      });
      return null;
    }
    if (toolBlock.name !== SELECT_PAGES_TOOL_NAME) {
      recordFailure({
        attempt,
        reason: "unexpected_tool_name",
        response: summarizeResponse(response),
        toolName: toolBlock.name,
      });
      return null;
    }
    const result = SelectPagesSchema.safeParse(toolBlock.input);
    if (!result.success) {
      recordFailure({
        attempt,
        reason: "schema_mismatch",
        response: summarizeResponse(response),
        schemaIssues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      });
      return null;
    }
    return result.data;
  });

  if (parsed === null) {
    if (lastError !== null) {
      // The selector's provider call threw on its final attempt (e.g. an
      // upstream HTTP error). Surface the underlying error rather than
      // reporting it as a model-output problem.
      const detail =
        lastError instanceof Error ? lastError.message : String(lastError);
      const redactedDetail = truncate(
        redactLogString(detail),
        ERROR_MESSAGE_MAX_CHARS,
      );
      log.warn(
        {
          candidateCount: ordered.length,
          stableCount: pool.stable.length,
          finderCount: pool.finder.length,
          callSite: MEMORY_V3_SELECT_CALL_SITE,
          providerName: provider.name,
          failures,
        },
        "pool selector provider call failed after retries",
      );
      throw new MemoryV3RetrievalUnavailableError(
        `memory-v3 pool selector provider call failed after retries: ${redactedDetail}`,
        {
          cause: lastError,
          conversationNotice: providerBillingNoticeFromError(lastError),
        },
      );
    }
    log.warn(
      {
        candidateCount: ordered.length,
        stableCount: pool.stable.length,
        finderCount: pool.finder.length,
        callSite: MEMORY_V3_SELECT_CALL_SITE,
        providerName: provider.name,
        failures,
      },
      "pool selector returned no usable tool_use after retries",
    );
    throw new MemoryV3RetrievalUnavailableError(
      "memory-v3 pool selector returned no usable selection after retries",
    );
  }

  // Omitted `ids` is the recall-safe "keep all candidates" signal.
  if (parsed.ids === undefined) {
    return { pages: selectAllPoolCandidates(pool), keptAll: true };
  }

  // Map 1-based IDs over the concatenated numbering, dropping out-of-range
  // IDs without throwing, then merge the picked lines per slug.
  const picked = parsed.ids
    .filter((id) => id >= 1 && id <= ordered.length)
    .map((id) => id - 1);
  return { pages: mergeSelectedLines(ordered, picked), keptAll: false };
}
