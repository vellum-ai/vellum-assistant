/**
 * Runtime-injection stripping for compaction and overflow recovery.
 *
 * Runtime injections (turn context, memory, NOW.md, workspace, Slack
 * chronological, etc.) persist in message history to keep the conversation
 * prefix stable for Anthropic's prefix caching. They only need to be removed
 * when compaction rewrites the message array, so the compactor summarizes the
 * raw persistent messages rather than the ephemeral injected blocks.
 *
 * This module is the compaction-layer home for that strip so both the agent
 * loop (which drives the compaction pipeline) and the compactor can call it
 * without reaching up into the daemon orchestrator.
 */
import {
  MEMORY_SPOTLIGHT_PREFIX,
  MEMORY_SPOTLIGHT_SUFFIX,
} from "../plugins/defaults/memory/memory-marker.js";
import type { Message } from "../providers/types.js";

/**
 * A matcher for an injected text block. A plain string matches by prefix
 * (`startsWith`). A `{ prefix, suffix }` wrapper requires BOTH the opening
 * prefix and the closing suffix, so user-authored content that merely begins
 * with an injection-like opening tag (e.g. a message discussing `<info>`
 * markup) is not mistaken for an injected block and dropped. This mirrors
 * `countMemoryPrefixBlocks`, which only treats `<memory>…</memory>` /
 * `<info>…</info>` blocks as injected when the full wrapper is present.
 */
export type InjectionMatcher = string | { prefix: string; suffix: string };

/**
 * Whether an injected text block matches any of the given matchers. A plain
 * string matches by prefix; a `{ prefix, suffix }` wrapper requires both ends
 * so user-authored text merely opening with an injection-like tag is kept.
 */
function textBlockMatchesInjection(
  text: string,
  matchers: InjectionMatcher[],
): boolean {
  return matchers.some((m) =>
    typeof m === "string"
      ? text.startsWith(m)
      : text.startsWith(m.prefix) && text.endsWith(m.suffix),
  );
}

/** Drop the matching injection text blocks from a single content array. */
function filterInjectionBlocks(
  content: Message["content"],
  matchers: InjectionMatcher[],
): Message["content"] {
  return content.filter(
    (block) =>
      block.type !== "text" || !textBlockMatchesInjection(block.text, matchers),
  );
}

/**
 * Remove text blocks from user messages that match any of the given matchers.
 * If stripping removes all content blocks from a message, the message itself
 * is dropped.
 *
 * This is the shared primitive behind the individual strip* functions and
 * the `stripInjectionsForCompaction` pipeline.
 */
export function stripUserTextBlocksByPrefix(
  messages: Message[],
  matchers: InjectionMatcher[],
): Message[] {
  return messages
    .map((message) => {
      if (message.role !== "user") return message;
      const nextContent = filterInjectionBlocks(message.content, matchers);
      if (nextContent.length === message.content.length) return message;
      if (nextContent.length === 0) return null;
      return { ...message, content: nextContent };
    })
    .filter(
      (message): message is NonNullable<typeof message> => message != null,
    );
}

/**
 * Tail-scoped variant of {@link stripUserTextBlocksByPrefix}: remove matching
 * text blocks from ONLY the last message, and only when that message is a user
 * message. This mirrors the runtime injection step, which applies every
 * per-turn block to the tail user message, so clearing the tail's stale copies
 * before re-injection makes re-injection idempotent.
 *
 * The tail message is retained even if all of its blocks are removed, so the
 * role-`"user"` tail invariant the re-injection step relies on is preserved.
 * Earlier messages are untouched, so per-message historical grounding (e.g.
 * each turn's `<turn_context>`) survives and the stable cached prefix — which
 * lives entirely before the tail — is never disturbed.
 */
export function stripTailUserTextBlocksByPrefix(
  messages: Message[],
  matchers: InjectionMatcher[],
): Message[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return messages;
  const nextContent = filterInjectionBlocks(last.content, matchers);
  if (nextContent.length === last.content.length) return messages;
  return [...messages.slice(0, -1), { ...last, content: nextContent }];
}

/**
 * Full-wrapper matcher for the memory-v3 ephemeral `<memory_spotlight>` block.
 * Shared by the per-turn scoped strip ({@link stripSpotlightInjections}) and
 * the compaction pipeline below so both recognize exactly the same wrapper.
 */
const MEMORY_SPOTLIGHT_MATCHER: InjectionMatcher = {
  prefix: MEMORY_SPOTLIGHT_PREFIX,
  suffix: MEMORY_SPOTLIGHT_SUFFIX,
};

/**
 * Remove memory-v3 `<memory_spotlight>` blocks from every user message — and
 * ONLY those blocks. The spotlight is ephemeral by contract: runtime assembly
 * strip-and-replaces it each turn (the previous turn's spotlight is stale),
 * while the frozen `<memory>` card blocks stay byte-identical in history for
 * prompt caching. This is deliberately a scoped, single-id strip — the old
 * whole-layer `stripAllMemoryInjections` replace is gone.
 */
export function stripSpotlightInjections(messages: Message[]): Message[] {
  return stripUserTextBlocksByPrefix(messages, [MEMORY_SPOTLIGHT_MATCHER]);
}

/** `<NOW.md>` scratchpad prefixes (current tag, pre-line-limit variant, legacy `<now_scratchpad>`) — shared with `stripNowScratchpad` so the two strip paths can't drift. */
export const NOW_SCRATCHPAD_STRIP_PREFIXES: InjectionMatcher[] = [
  "<NOW.md Always keep this up to date",
  "<now_scratchpad>",
];

/**
 * Matchers stripped by the compaction pipeline (order doesn't matter — single
 * pass). Exported so the post-compaction re-injection path can reuse this set
 * as the base of its idempotency strip without duplicating it.
 */
export const RUNTIME_INJECTION_PREFIXES: InjectionMatcher[] = [
  "<channel_capabilities>",
  "<channel_command_context>",
  "<disk_pressure_warning>",
  "<channel_turn_context>", // backward-compat: strip legacy separate channel blocks
  "<guardian_context>",
  "<inbound_actor_context>", // backward-compat: strip legacy separate actor blocks
  "<interface_turn_context>", // backward-compat: strip legacy separate interface blocks
  // NOTE: <turn_context> is intentionally NOT stripped — unified turn context
  // blocks persist in history so the assistant retains temporal/actor grounding.
  "<background_turn>",
  "<memory_context __injected>",
  "<memory_context>", // backward-compat: strip legacy blocks from pre-__injected history
  // The static `memory-v2-static` block (`<info>\n…</info>`) and the
  // dynamic activation block (`<memory>\n…</memory>`, plus legacy
  // `<memory __injected>…`) are both stripped so each compaction
  // re-injects the freshest essentials/threads/recent/buffer view and
  // re-runs the activation pipeline, matching the `<knowledge_base>`
  // cadence. The activation pipeline dedupes via `everInjected`, and
  // compaction handles aggregate growth, so accumulation does not cause
  // unbounded context growth. Both wrappers may appear in persisted rows.
  //
  // These two use the full `{ prefix, suffix }` wrapper shape (not a bare
  // prefix) so that user-authored text merely starting with `<memory>\n` or
  // `<info>\n` is never silently dropped during compaction/`/clean`. This
  // matches the full-wrapper requirement in `countMemoryPrefixBlocks`.
  { prefix: "<memory>\n", suffix: "\n</memory>" },
  { prefix: "<info>\n", suffix: "\n</info>" },
  // The memory-v3 ephemeral spotlight block. Normally strip-and-replaced every
  // turn by `stripSpotlightInjections`, but registered here too so compaction
  // and overflow recovery remove a stale spotlight along with the rest of the
  // runtime injections. Full-wrapper shape for the same reason as `<memory>`.
  MEMORY_SPOTLIGHT_MATCHER,
  "<voice_call_control>",
  "<workspace_top_level>", // backward-compat: strip legacy workspace blocks
  // The `<workspace>` top-level block is stripped so each compaction re-injects
  // a fresh directory snapshot rather than carrying a stale listing into the
  // summary — matching the `<knowledge_base>`/`<NOW.md>` cadence and keeping the
  // `workspace-context` injector's presence detection in lockstep (the block is
  // present exactly when compaction would strip it). The full `{ prefix, suffix }`
  // wrapper shape ensures user-authored text merely starting with `<workspace>\n`
  // is never mistaken for an injected block.
  { prefix: "<workspace>\n", suffix: "\n</workspace>" },
  "<temporal_context>\nToday:", // backward-compat: strip legacy temporal blocks
  "<active_subagents>",
  "<active_workspace>",
  "<active_dynamic_page>",
  "<non_interactive_context>",
  ...NOW_SCRATCHPAD_STRIP_PREFIXES,
  "<knowledge_base>",
  "<pkb>", // backward-compat: strip legacy tag from pre-rename history
  "<system_reminder>",
  "<transport_hints>",
  // The Slack active-thread focus block is non-persisted and injected on
  // the FINAL user turn only. Strip it here so re-assembly during compaction
  // and overflow recovery does not duplicate it across turns.
  "<active_thread>",
  "<system_notice>One or more tool calls returned an error.",
];

/**
 * Strip all runtime-injected context from message history in a single pass.
 *
 * Used only during compaction and overflow recovery — not on normal turns.
 * Runtime injections persist in history to keep the conversation prefix
 * stable for Anthropic's prefix caching. Stripping is only needed when
 * compaction rewrites the message array (cache miss is expected anyway).
 */
export function stripInjectionsForCompaction(messages: Message[]): Message[] {
  return stripUserTextBlocksByPrefix(messages, RUNTIME_INJECTION_PREFIXES);
}
