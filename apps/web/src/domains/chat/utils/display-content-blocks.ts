/**
 * Resolve a display row's body to a single ordered `DisplayContentBlock[]` —
 * the one list the transcript renderer walks.
 *
 * History rows carry `contentBlocks` mapped from the wire (see
 * `mapWireContentBlocks`). Live SSE rows don't build blocks yet, so
 * `resolveContentBlocks` derives an equivalent list from the positional
 * `contentOrder`/`textSegments`/`thinkingSegments` arrays the stream updaters
 * still maintain. The two producers yield identical block lists for the same
 * underlying content, so the renderer never branches on the source.
 */

import type { ConversationContentBlock } from "@vellumai/assistant-api";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type {
  DisplayContentBlock,
  DisplayMessage,
  Surface,
} from "@/domains/chat/types/types";

/**
 * Resolve a surface reference from a row's `surfaces` array. The streaming
 * path references surfaces by their UUID `surfaceId`; the server's positional
 * `contentOrder` references them by index ("0", "1", …).
 */
function resolveSurfaceRef(
  surfaces: readonly Surface[] | undefined,
  id: string,
): Surface | undefined {
  if (!surfaces) {
    return undefined;
  }
  const direct = surfaces.find((s) => s.surfaceId === id);
  if (direct) {
    return direct;
  }
  const idx = parseInt(id, 10);
  if (!isNaN(idx) && idx < surfaces.length) {
    return surfaces[idx];
  }
  return undefined;
}

/**
 * Resolve a tool-call reference from a row's `toolCalls` array. The streaming
 * path references tool calls by their live id; the server's positional
 * `contentOrder` references them by index.
 */
function resolveToolCallRef(
  toolCalls: readonly ChatMessageToolCall[] | undefined,
  id: string,
): ChatMessageToolCall | undefined {
  if (!toolCalls) {
    return undefined;
  }
  const direct = toolCalls.find((tc) => tc.id === id);
  if (direct) {
    return direct;
  }
  const idx = parseInt(id, 10);
  if (!isNaN(idx) && idx < toolCalls.length) {
    return toolCalls[idx];
  }
  return undefined;
}

/**
 * Map the wire `contentBlocks` projection onto display blocks. `text` and
 * `thinking` carry their content inline; `tool_use` and `surface` are enriched
 * to the row's display payloads — the Nth `tool_use` block resolves to the Nth
 * entry of the already-mapped display `toolCalls` (same order the daemon
 * emits), and `surface` blocks resolve by `surfaceId`. `attachment` blocks are
 * dropped: attachments render from the row's hydrated `attachments` array.
 */
export function mapWireContentBlocks(
  blocks: readonly ConversationContentBlock[],
  toolCalls: readonly ChatMessageToolCall[] | undefined,
  surfaces: readonly Surface[] | undefined,
): DisplayContentBlock[] {
  const result: DisplayContentBlock[] = [];
  let toolUseOrdinal = 0;
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        result.push({ type: "text", text: block.text });
        break;
      case "thinking":
        result.push({ type: "thinking", thinking: block.thinking });
        break;
      case "tool_use": {
        const toolCall = toolCalls?.[toolUseOrdinal];
        toolUseOrdinal += 1;
        if (toolCall) {
          result.push({ type: "tool_use", toolCall });
        }
        break;
      }
      case "surface": {
        const surface = resolveSurfaceRef(surfaces, block.surface.surfaceId);
        if (surface) {
          result.push({ type: "surface", surface });
        }
        break;
      }
      case "attachment":
        break;
    }
  }
  return result;
}

/**
 * Derive an ordered display block list from a row's positional arrays. Mirrors
 * the resolution the transcript renderer historically performed inline while
 * walking `contentOrder`: `text`/`thinking` ids index into the segment arrays,
 * `tool`/`toolCall` and `surface` ids resolve against the row's display
 * arrays. Entries whose referenced content is missing are skipped, matching
 * the renderer's per-entry `null` guards.
 *
 * Surfaces attached to the row but absent from `contentOrder` are intentionally
 * NOT appended here — the renderer's legacy branch renders those as a trailing
 * tail, and appending them would make them render in the interleaved branch
 * too. Used as the fallback for live rows until the stream updaters build
 * `contentBlocks` directly.
 */
export function deriveContentBlocks(
  message: DisplayMessage,
): DisplayContentBlock[] {
  const result: DisplayContentBlock[] = [];
  const textSegments = message.textSegments ?? [];
  const thinkingSegments = message.thinkingSegments ?? [];

  for (const entry of message.contentOrder ?? []) {
    if (entry.type === "text") {
      const idx = parseInt(entry.id, 10);
      const text = !isNaN(idx) ? textSegments[idx] : undefined;
      if (text !== undefined) {
        result.push({ type: "text", text });
      }
    } else if (entry.type === "thinking") {
      const idx = parseInt(entry.id, 10);
      const thinking = !isNaN(idx) ? thinkingSegments[idx] : undefined;
      if (thinking !== undefined) {
        result.push({ type: "thinking", thinking });
      }
    } else if (entry.type === "toolCall" || entry.type === "tool") {
      const toolCall = resolveToolCallRef(message.toolCalls, entry.id);
      if (toolCall) {
        result.push({ type: "tool_use", toolCall });
      }
    } else if (entry.type === "surface") {
      const surface = resolveSurfaceRef(message.surfaces, entry.id);
      if (surface) {
        result.push({ type: "surface", surface });
      }
    }
  }

  return result;
}

/**
 * The single render source for a display row's body. Prefers the
 * `contentBlocks` built from the wire (history) and falls back to deriving
 * blocks from the positional arrays (live SSE rows).
 */
export function resolveContentBlocks(
  message: DisplayMessage,
): DisplayContentBlock[] {
  return message.contentBlocks ?? deriveContentBlocks(message);
}

/**
 * A rendered group of consecutive content blocks. Adjacent `tool_use` blocks
 * collapse into one `toolCalls` group (rendered as a single tool-progress
 * card) and adjacent `thinking` blocks collapse into one `thinking` group
 * (their text joined with newlines), mirroring macOS `groupContentBlocks`.
 * `text` and `surface` blocks each form their own group.
 *
 * `index` is the position of the group's first block within the resolved
 * block list — a stable per-row id used for thinking-block expansion keys.
 */
export type DisplayContentGroup =
  | { type: "text"; text: string; index: number }
  | { type: "thinking"; thinking: string; index: number }
  | { type: "toolCalls"; toolCalls: ChatMessageToolCall[]; index: number }
  | { type: "surface"; surface: Surface; index: number };

/**
 * Collapse a resolved block list into render groups. The grouping rules are
 * shared between the transcript renderer and the leading-thinking-text helper
 * so a tool group's index lines up across both — the renderer passes the same
 * group index back to `getLeadingThinkingText` to surface the immediately
 * preceding text as the card's reasoning preview.
 */
export function groupContentBlocks(
  blocks: readonly DisplayContentBlock[],
): DisplayContentGroup[] {
  const groups: DisplayContentGroup[] = [];
  blocks.forEach((block, index) => {
    const last = groups[groups.length - 1];
    switch (block.type) {
      case "tool_use":
        if (last?.type === "toolCalls") {
          last.toolCalls.push(block.toolCall);
        } else {
          groups.push({ type: "toolCalls", toolCalls: [block.toolCall], index });
        }
        break;
      case "thinking":
        if (last?.type === "thinking") {
          last.thinking = [last.thinking, block.thinking]
            .filter(Boolean)
            .join("\n");
        } else {
          groups.push({ type: "thinking", thinking: block.thinking, index });
        }
        break;
      case "text":
        groups.push({ type: "text", text: block.text, index });
        break;
      case "surface":
        groups.push({ type: "surface", surface: block.surface, index });
        break;
    }
  });
  return groups;
}
