/**
 * Incremental chat-block projection for an ACP run's detail view.
 *
 * Sibling to `acp-run-step-projection.ts`: where the step projection folds the
 * raw ACP event buffer into a timeline of agent steps (user echoes dropped),
 * this projection folds the same `AcpRunRawEvent[]` (from `acp-run-store.ts`)
 * into an ordered `AcpChatBlock[]` for a Devin-style chat transcript — user
 * turns INCLUDED, rendered as their own bubbles.
 *
 * The store appends each event to `entry.events` (see `acp-run-store.ts`
 * `appendEvent`) without coalescing message/thought chunks, so the live shape
 * is always a plain **append** — `[...events, ev]`, a new array with every
 * prior element reference-equal and one new element at the tail. Coalescing
 * same-`messageId` chunks into a single block happens here, mirroring the step
 * projection so the two never drift on chunk handling.
 *
 * `computeAcpRunChatBlocks(events)` is O(n); running it on every streamed event
 * is O(n^2) over a run. The incremental projector replays only the diff vs the
 * previous call through the same `applyAcpChatEvent` reducer the full rebuild
 * uses, so the two paths can't drift. Any diff that isn't a plain append falls
 * back to a full O(n) rebuild, which is always correct.
 *
 * `isComplete` rule for agent/thinking blocks: a block flips to `isComplete:
 * true` once any later block is appended after it. The trailing block is left
 * `isComplete: false` until the run produces a subsequent block or terminates.
 */

import { useRef } from "react";

import {
  LOCAL_MARKER_ID_PREFIX,
  STEER_MARKER_PREFIX,
  type AcpRunRawEvent,
} from "@/domains/chat/acp-run-store";
import type { AcpToolStatus } from "@/domains/chat/acp-run-step-projection";

// ---------------------------------------------------------------------------
// Chat block union
// ---------------------------------------------------------------------------

export type AcpChatBlock =
  | { kind: "user"; id: string; content: string }
  | { kind: "agent"; messageId: string; content: string; isComplete: boolean }
  | { kind: "thinking"; messageId: string; content: string; isComplete: boolean }
  | {
      kind: "tool";
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: AcpToolStatus;
      content?: string;
      locations?: { path: string; line?: number }[];
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | { kind: "plan"; entries: { label: string; checked: boolean }[] };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Synthetic id for chunks from older daemons that don't emit a messageId. */
const ANONYMOUS_MESSAGE_ID = "";

/** Map a raw daemon `toolStatus` to a block status; keep `fallback` if absent. */
function mapToolStatus(
  toolStatus: string | undefined,
  fallback: AcpToolStatus,
): AcpToolStatus {
  switch (toolStatus) {
    case "complete":
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "error";
    case undefined:
      return fallback;
    default:
      return "running";
  }
}

/**
 * Is this `agent_message_chunk` actually an optimistic steering marker (a local
 * user turn), not real agent output? `appendLocalMarker` tags markers with a
 * `local-marker-*` messageId AND a `↻ Steering: ` content prefix; either signal
 * is enough so a marker is recognized even if one shape changes.
 */
function isSteerMarker(event: AcpRunRawEvent): boolean {
  return (
    (event.messageId?.startsWith(LOCAL_MARKER_ID_PREFIX) ?? false) ||
    (event.content?.startsWith(STEER_MARKER_PREFIX) ?? false)
  );
}

/** Strip the steer-marker prefix so the bubble shows the raw instruction. */
function stripSteerPrefix(content: string | undefined): string {
  const text = content ?? "";
  return text.startsWith(STEER_MARKER_PREFIX)
    ? text.slice(STEER_MARKER_PREFIX.length)
    : text;
}

/** Mark the trailing agent/thinking block (if any, still live) as complete. */
function closeTrailingMessage(blocks: AcpChatBlock[]): void {
  const last = blocks[blocks.length - 1];
  if (
    last &&
    (last.kind === "agent" || last.kind === "thinking") &&
    !last.isComplete
  ) {
    blocks[blocks.length - 1] = { ...last, isComplete: true };
  }
}

/**
 * Fold a single raw ACP event into `blocks` (mutated in place). Shared by the
 * full rebuild and the incremental projector so the two paths can't diverge.
 */
export function applyAcpChatEvent(
  blocks: AcpChatBlock[],
  event: AcpRunRawEvent,
): void {
  // A local steer marker rides in on an `agent_message_chunk`; route it to a
  // user block before the agent-chunk handling below claims it.
  if (event.updateType === "agent_message_chunk" && isSteerMarker(event)) {
    closeTrailingMessage(blocks);
    blocks.push({
      kind: "user",
      id: event.messageId ?? `steer-${blocks.length}`,
      content: stripSteerPrefix(event.content),
    });
    return;
  }

  switch (event.updateType) {
    case "user_message_chunk": {
      const messageId = event.messageId ?? ANONYMOUS_MESSAGE_ID;
      const text = stripSteerPrefix(event.content);
      const last = blocks[blocks.length - 1];
      // Coalesce consecutive same-id user chunks into one bubble; else start one.
      if (last && last.kind === "user" && last.id === messageId) {
        blocks[blocks.length - 1] = { ...last, content: last.content + text };
      } else {
        closeTrailingMessage(blocks);
        blocks.push({ kind: "user", id: messageId, content: text });
      }
      // The agent may echo an accepted steer back as a real user chunk.
      // Reconcile it with the optimistic `local-marker-*` bubble appended for
      // that steer so the instruction doesn't appear twice: once the echoed
      // bubble's FULLY assembled content matches a marker, drop the marker.
      // Matching the assembled content (not a partial chunk) keeps this correct
      // even when the echo streams across several user_message_chunks.
      const assembled = (
        blocks[blocks.length - 1] as Extract<AcpChatBlock, { kind: "user" }>
      ).content;
      for (let i = 0; i < blocks.length - 1; i++) {
        const b = blocks[i];
        if (
          b.kind === "user" &&
          b.id.startsWith(LOCAL_MARKER_ID_PREFIX) &&
          b.content === assembled
        ) {
          blocks.splice(i, 1);
          break;
        }
      }
      return;
    }

    case "agent_message_chunk": {
      const messageId = event.messageId ?? ANONYMOUS_MESSAGE_ID;
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "agent" && last.messageId === messageId) {
        blocks[blocks.length - 1] = {
          ...last,
          content: last.content + (event.content ?? ""),
        };
        return;
      }
      // Some agents stream a message as id-less deltas, then re-send the whole
      // message as one chunk that finally carries a messageId. Adopt the id
      // onto the streamed block rather than opening a duplicate of it.
      if (
        messageId !== ANONYMOUS_MESSAGE_ID &&
        last &&
        last.kind === "agent" &&
        last.messageId === ANONYMOUS_MESSAGE_ID &&
        !last.isComplete &&
        last.content === (event.content ?? "")
      ) {
        blocks[blocks.length - 1] = { ...last, messageId };
        return;
      }
      closeTrailingMessage(blocks);
      blocks.push({
        kind: "agent",
        messageId,
        content: event.content ?? "",
        isComplete: false,
      });
      return;
    }

    case "agent_thought_chunk": {
      const messageId = event.messageId ?? ANONYMOUS_MESSAGE_ID;
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "thinking" && last.messageId === messageId) {
        blocks[blocks.length - 1] = {
          ...last,
          content: last.content + (event.content ?? ""),
        };
        return;
      }
      // Open a thinking block even for an empty thought "signal" (some agents,
      // e.g. claude-agent-acp, emit reasoning markers with no text) so the
      // transcript still surfaces that the agent was thinking; the card stays
      // expandable and fills in if reasoning text streams in under this id.
      closeTrailingMessage(blocks);
      blocks.push({
        kind: "thinking",
        messageId,
        content: event.content ?? "",
        isComplete: false,
      });
      return;
    }

    case "tool_call": {
      const toolCallId = event.toolCallId;
      if (toolCallId === undefined) return;
      closeTrailingMessage(blocks);
      blocks.push({
        kind: "tool",
        toolCallId,
        title: event.toolTitle ?? "",
        toolKind: event.toolKind,
        // Honor a terminal status on the initial tool_call (hydrated snapshots
        // may carry one with no follow-up update); default to "running".
        status: mapToolStatus(event.toolStatus, "running"),
        content: event.content,
        locations: parseLocations(event),
        rawInput: event.rawInput,
        rawOutput: event.rawOutput,
      });
      return;
    }

    case "tool_call_update": {
      const toolCallId = event.toolCallId;
      if (toolCallId === undefined) return;
      const index = blocks.findIndex(
        (b) => b.kind === "tool" && b.toolCallId === toolCallId,
      );
      if (index === -1) return;
      const target = blocks[index] as Extract<AcpChatBlock, { kind: "tool" }>;
      // A valid `locations` array (including `[]`) REPLACES the snapshot; an
      // empty array clears stale locations. `undefined` means the field is
      // absent/malformed — preserve the previous value.
      const parsedLocations = parseLocations(event);
      blocks[index] = {
        ...target,
        title: event.toolTitle ?? target.title,
        toolKind: event.toolKind ?? target.toolKind,
        status: mapToolStatus(event.toolStatus, target.status),
        // ACP `ToolCallUpdate.content` REPLACES the snapshot, not a delta.
        content: event.content ?? target.content,
        locations: parsedLocations ?? target.locations,
        rawInput:
          event.rawInput !== undefined ? event.rawInput : target.rawInput,
        rawOutput:
          event.rawOutput !== undefined ? event.rawOutput : target.rawOutput,
      };
      return;
    }

    case "plan": {
      const entries = parsePlanEntries(event.content);
      if (entries === null) return;
      const index = blocks.findIndex((b) => b.kind === "plan");
      const planBlock: AcpChatBlock = { kind: "plan", entries };
      if (index === -1) {
        closeTrailingMessage(blocks);
        blocks.push(planBlock);
      } else {
        blocks[index] = planBlock;
      }
      return;
    }
  }
}

/**
 * Normalize a tool event's typed `locations` field for a chat block.
 *
 * Returns `undefined` when the field is ABSENT or not an array (the caller
 * treats this as "no change"). A VALID array — including an empty one — returns
 * a parsed array (possibly `[]`), so an ACP `locations: []` update can clear
 * stale locations rather than preserving the previous value. The runtime guard
 * tolerates off-wire shapes that don't match the declared type.
 */
function parseLocations(
  event: AcpRunRawEvent,
): { path: string; line?: number }[] | undefined {
  const raw = event.locations;
  if (!Array.isArray(raw)) return undefined;
  const out: { path: string; line?: number }[] = [];
  for (const item of raw) {
    const obj = (item ?? {}) as Record<string, unknown>;
    if (typeof obj.path !== "string") continue;
    out.push(
      typeof obj.line === "number"
        ? { path: obj.path, line: obj.line }
        : { path: obj.path },
    );
  }
  return out;
}

/**
 * Parse a `plan` event's JSON `content` into entries. Returns `null` (skip the
 * event) on malformed JSON or an unexpected shape rather than throwing.
 * Mirrors the step projection's parser so the two stay in lockstep.
 */
function parsePlanEntries(
  content: string | undefined,
): { label: string; checked: boolean }[] | null {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { entries?: unknown })?.entries)
      ? (parsed as { entries: unknown[] }).entries
      : null;
  if (raw === null) return null;
  return raw.map((item) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    const text = obj.content ?? obj.label ?? "";
    return {
      label: typeof text === "string" ? text : String(text),
      checked: obj.checked === true || obj.status === "completed",
    };
  });
}

/**
 * Build the full `AcpChatBlock[]` for an event buffer by folding
 * `applyAcpChatEvent` over each event. Single source of truth for the
 * projection.
 */
export function computeAcpRunChatBlocks(
  events: AcpRunRawEvent[],
): AcpChatBlock[] {
  const blocks: AcpChatBlock[] = [];
  for (const event of events) applyAcpChatEvent(blocks, event);
  return blocks;
}

// ---------------------------------------------------------------------------
// Incremental projector
// ---------------------------------------------------------------------------

/**
 * Classify how `next` differs from `prev` at the raw-event-array level.
 *  - `identity` — same array reference.
 *  - `first` — no previous (cold cache).
 *  - `append` — `prev` is a strict prefix of `next`; replay from `prev.length`.
 *  - `mutate-last` — same length, last element changed; full rebuild (a grown
 *    coalesced block can't be cheaply re-derived).
 *  - `fallback` — anything else (full-replace, truncation, reorder).
 */
function classifyAcpDiff(
  prev: AcpRunRawEvent[] | null,
  next: AcpRunRawEvent[],
):
  | { kind: "identity" | "first" | "mutate-last" | "fallback" }
  | { kind: "append"; from: number } {
  if (prev === next) return { kind: "identity" };
  if (prev === null) return { kind: "first" };
  if (next.length < prev.length) return { kind: "fallback" };

  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) {
      if (i === prev.length - 1 && next.length === prev.length) {
        return { kind: "mutate-last" };
      }
      return { kind: "fallback" };
    }
  }

  if (next.length === prev.length) return { kind: "identity" };
  return { kind: "append", from: prev.length };
}

/**
 * Create a stateful incremental projector. `project(events)` returns the
 * `AcpChatBlock[]` for `events`, replaying only the diff vs the previous call.
 * Returns the cached array by reference when the input is unchanged so
 * `React.memo` consumers can bail.
 *
 * One projector instance owns one cache slot — hold it per component instance
 * (see `useAcpRunChatBlocks`), never module-global.
 */
export function createAcpRunChatProjection() {
  let prevEvents: AcpRunRawEvent[] | null = null;
  let blocks: AcpChatBlock[] = [];

  function fullBuild(events: AcpRunRawEvent[]): AcpChatBlock[] {
    blocks = computeAcpRunChatBlocks(events);
    prevEvents = events;
    return blocks;
  }

  function project(events: AcpRunRawEvent[]): AcpChatBlock[] {
    const diff = classifyAcpDiff(prevEvents, events);

    switch (diff.kind) {
      case "identity":
        return blocks;

      case "first":
        return fullBuild(events);

      case "append": {
        const clone = blocks.slice();
        for (let i = diff.from; i < events.length; i++) {
          applyAcpChatEvent(clone, events[i]!);
        }
        prevEvents = events;
        blocks = clone;
        return blocks;
      }

      case "mutate-last":
      case "fallback":
        return fullBuild(events);
    }
  }

  return { project };
}

/**
 * Hook wrapper: holds an incremental projector per component instance (in a
 * `useRef`, tied to the component lifecycle — never a module-global cache).
 * Returns a referentially-stable array across renders when the input events
 * are unchanged.
 */
export function useAcpRunChatBlocks(events: AcpRunRawEvent[]): AcpChatBlock[] {
  const projectorRef = useRef<ReturnType<
    typeof createAcpRunChatProjection
  > | null>(null);

  // Intentional render-phase ref usage: the projector is a per-instance
  // diff-aware cache (like `useMemo`, but it must run every render to fold in
  // new events).
  /* eslint-disable react-hooks/refs -- per-instance projection cache (see above) */
  if (projectorRef.current == null) {
    projectorRef.current = createAcpRunChatProjection();
  }
  return projectorRef.current.project(events);
  /* eslint-enable react-hooks/refs */
}
