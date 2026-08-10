// ---------------------------------------------------------------------------
// Memory substrate — Static context loader for user-message auto-injection
// ---------------------------------------------------------------------------
//
// Shared by the v2 injection engine and memory-v3; active whenever
// `usesConceptPageMemory()` holds.
//
// Reads the four top-level memory files (essentials/threads/recent/buffer)
// and returns a concatenated, header-wrapped block ready to splice into the
// current user message via the injector chain.
//
// Pairs with the v2 per-turn activation block (`maybeRouteV2Injection` in
// `conversation-graph-memory.ts`, which threads through `injectTextBlock`)
// — that block carries activated concept pages selected by the activation
// pipeline; this static block carries the always-relevant aggregate views
// written by consolidation and the user. Both land on the user message so
// the system prompt stays cache-stable.
//
// Refresh cadence is owned by the caller: the agent loop only passes the
// content through when `mode === "full"` (first turn / post-compaction),
// matching the existing PKB auto-inject pattern.
//
// Three of the four files are curated aggregate views that consolidation
// keeps lean. `memory/buffer.md` is not: it is the raw append-only staging
// log that `remember()` writes and consolidation drains, so its length is
// bounded only by how far behind consolidation has fallen. The injected
// Buffer section is therefore capped: see `capBufferSection`.

import type { ChannelId } from "../../../../channels/types.js";
import { usesConceptPageMemory } from "../../../../config/memory-v3-gate.js";
import { readPromptFile } from "../../../../prompts/system-prompt.js";
import { getMemoryConfig } from "../config.js";
import { getWorkspacePromptPath } from "../paths.js";
import { resolveSubstrateTuning } from "./tuning.js";

interface MemoryV2StaticBlock {
  heading: string;
  file: string;
}

const BUFFER_FILE = "memory/buffer.md";

const MEMORY_V2_STATIC_BLOCKS: readonly MemoryV2StaticBlock[] = [
  { heading: "## Essentials", file: "memory/essentials.md" },
  { heading: "## Threads", file: "memory/threads.md" },
  { heading: "## Recent", file: "memory/recent.md" },
  { heading: "## Buffer", file: BUFFER_FILE },
];

/**
 * Leader line on a Buffer section that was capped, so the model knows the
 * section is a tail rather than the whole backlog and where the rest lives.
 */
const BUFFER_INJECTION_NOTICE =
  "(Older entries trimmed. Read memory/buffer.md for the full backlog.)";

/**
 * Cap the Buffer section at its most recent `maxLines` non-empty lines,
 * returning the content unchanged when it already fits or when `maxLines` is
 * `null`.
 *
 * The bound is `consolidation_max_buffer_lines`, the same threshold at which
 * the scheduler already considers the buffer overdue for consolidation (see
 * `jobs-worker.ts`). Reusing it means the injected buffer never exceeds one
 * consolidation's worth of backlog, and that a workspace whose consolidation
 * keeps up sees byte-identical output. `null` disables the size trigger, so
 * the operator has opted out of size-based buffer management and the
 * injection is left unbounded to match.
 *
 * Non-empty lines are the unit because that is what the scheduler counts
 * (`countBufferLines`), so the two readings of "how big is the buffer" agree.
 * Retained lines keep their original spacing; the notice replaces everything
 * before them.
 *
 * The cap is a bound on buffered *content*, not a hard line budget: a single
 * entry whose body alone exceeds it keeps its opening line and an elision
 * marker (see {@link retainFromEntryBoundary}), so the output can run to
 * `maxLines + 2`.
 */
function capBufferSection(content: string, maxLines: number | null): string {
  if (maxLines === null) {
    return content;
  }
  const lines = content.split("\n");
  let kept = 0;
  let start = lines.length;
  while (start > 0 && kept < maxLines) {
    start--;
    if (lines[start]!.trim().length > 0) {
      kept++;
    }
  }
  if (start === 0) {
    return content;
  }
  while (start < lines.length && lines[start]!.trim().length === 0) {
    start++;
  }
  return `${BUFFER_INJECTION_NOTICE}\n${retainFromEntryBoundary(lines, start)}`;
}

/**
 * Matches the first line of a buffer entry: `- [Mon D, h:mm AM/PM] fact`, the
 * shape `formatRememberEntry` writes. The timestamp must be present and
 * timestamp-shaped, so a bullet carrying other bracketed text (a `- [ ]`
 * checklist item inside a multiline fact) reads as a continuation line.
 *
 * Duplicated from `BUFFER_ENTRY_REGEX` in `graph-topology/pending-buffer.ts`
 * rather than imported: `substrate/` is the bottom layer and `graph-topology/`
 * already imports it, so importing back would invert the layering. The two
 * must stay in sync.
 */
const BUFFER_ENTRY_START_REGEX =
  /^-\s+\[[A-Z][a-z]{2}\s+\d{1,2},\s+\d{1,2}:\d{2}\s+[AP]M\]/;

/**
 * Marker replacing the head of an entry whose body alone exceeds the cap, so
 * the retained tail reads as a fragment of the entry above it rather than as
 * the whole fact.
 */
const ENTRY_BODY_TRIMMED_NOTICE =
  "(This entry's body was trimmed. Read memory/buffer.md for the rest of it.)";

/**
 * Render the retained lines from `start`, moved onto an entry boundary so the
 * injected Buffer never opens on orphan continuation lines.
 *
 * A multiline `remember()` stores its body verbatim after the timestamped
 * first line, and consolidation reads non-timestamped lines as part of the
 * preceding entry. Cutting purely on a line count can therefore land inside a
 * fact and inject continuation lines stripped of the timestamp and opening
 * clause that give them meaning, which is worse than showing one fewer fact.
 *
 * Three cases, distinguished by what entry structure surrounds the cut:
 *
 * - **A later entry starts at or after the cut.** Drop the straddled entry and
 *   open on that one. Every surviving fact stays whole and the result can only
 *   shrink, so the cap still holds. This is the common case.
 * - **No later entry, but the cut sits inside one.** The newest entry's body is
 *   itself larger than the cap, so there is no whole entry to fall back to:
 *   dropping it would leave the section empty of facts, and the newest entry is
 *   the one most worth injecting. Keep its opening line (the timestamp and
 *   first clause the tail needs to be readable), then {@link
 *   ENTRY_BODY_TRIMMED_NOTICE}, then the tail. Costs two lines over the cap and
 *   attributes every retained line to a timestamped entry. When the cut fell on
 *   the opening line's immediate successor nothing was actually elided, so the
 *   whole entry is returned without the marker rather than claiming a trim that
 *   did not happen.
 * - **No entry structure at all.** A hand-written buffer that never went
 *   through `remember()`. Nothing to preserve, so the line cut stands.
 */
function retainFromEntryBoundary(lines: string[], start: number): string {
  const successor = findEntryStart(lines, start, 1);
  if (successor !== null) {
    return lines.slice(successor).join("\n");
  }
  const opening = findEntryStart(lines, start - 1, -1);
  if (opening === null) {
    return lines.slice(start).join("\n");
  }
  const elidedHead = lines
    .slice(opening + 1, start)
    .some((line) => line.trim().length > 0);
  if (!elidedHead) {
    return lines.slice(opening).join("\n");
  }
  return [
    lines[opening]!,
    ENTRY_BODY_TRIMMED_NOTICE,
    ...lines.slice(start),
  ].join("\n");
}

/** First index from `from` in direction `step` whose line starts an entry. */
function findEntryStart(
  lines: string[],
  from: number,
  step: 1 | -1,
): number | null {
  for (let i = from; i >= 0 && i < lines.length; i += step) {
    if (BUFFER_ENTRY_START_REGEX.test(lines[i]!)) {
      return i;
    }
  }
  return null;
}

/**
 * Build the static memory block, gated on concept-page memory being active
 * ({@link usesConceptPageMemory}). Empty/missing files are skipped; returns
 * `null` when the gate is off or every file is empty. The Buffer section is
 * capped by {@link capBufferSection}.
 *
 * `excludeBuffer` drops the `## Buffer` section. The consolidation run sets
 * it: the agent's contract there is the `memory/buffer.md` FILE — it reads,
 * routes, and rewrites it through file tools — so injecting a static snapshot
 * of the same content would duplicate the entire (potentially unbounded)
 * backlog into the turn's context and go stale the moment the agent edits
 * the file.
 */
export function readMemoryV2StaticContent(
  options: { excludeBuffer?: boolean } = {},
): string | null {
  const memoryConfig = getMemoryConfig();
  if (!usesConceptPageMemory(memoryConfig)) {
    return null;
  }
  const maxBufferLines =
    resolveSubstrateTuning(memoryConfig).consolidation_max_buffer_lines;

  const sections: string[] = [];
  for (const { heading, file } of MEMORY_V2_STATIC_BLOCKS) {
    const isBuffer = file === BUFFER_FILE;
    if (options.excludeBuffer === true && isBuffer) {
      continue;
    }
    const content = readPromptFile(getWorkspacePromptPath(file));
    if (!content) {
      continue;
    }
    sections.push(
      `${heading}\n\n${isBuffer ? capBufferSection(content, maxBufferLines) : content}`,
    );
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * Trust-class predicate for personal-memory injection. Personal memory
 * spans v2 static blocks (essentials/threads/recent/buffer), the PKB
 * context, and NOW.md — all of which can hold private user content. Block
 * injection when a non-guardian actor reaches the assistant over a remote
 * channel — otherwise the model can be prompt-injected into reciting
 * private memory. Internal flows (`sourceChannel: "vellum"`) and turns
 * with no trust context pass through unchanged; this gate exists only to
 * keep remote untrusted actors out.
 *
 * This is the trust-only gate. Cadence (first-turn / post-compaction) is
 * applied separately by the caller so that the freshest content remains
 * available for re-injection after a mid-turn reducer-triggered compaction
 * — the initial-injection turn may not have been a `shouldInjectNowAndPkb`
 * turn, but compaction strips the existing personal-memory blocks and we
 * still need the freshest content to re-inject.
 */
export function shouldExposePersonalMemory(args: {
  sourceChannel: ChannelId | undefined;
  isTrustedActor: boolean;
}): boolean {
  const isRemoteUntrustedActor =
    args.sourceChannel !== undefined &&
    args.sourceChannel !== "vellum" &&
    !args.isTrustedActor;
  return !isRemoteUntrustedActor;
}
