/**
 * Lockstep helpers for client-side surface state mutations.
 *
 * The transcript renders surfaces straight off the `surface` blocks in
 * `contentBlocks`, so any client-side change to a surface (data/title refresh,
 * optimistic completion, dismissal) must patch the block copy too — otherwise
 * the change never reaches the screen. A `surface` block is matched to its
 * positional `surfaces` entry by `surfaceId`, the same key the streaming and
 * ingest builders use.
 */

import type { ConversationContentBlock } from "@vellumai/assistant-api";
import type { DisplayMessage, Surface } from "@/domains/chat/types/types";

/**
 * Insert or update the `surface` block carrying `surface` (matched by
 * `surfaceId`), keeping the `contentBlocks` projection in lockstep with the
 * positional `surfaces` array.
 */
export function upsertSurfaceBlock(
  blocks: ConversationContentBlock[] | undefined,
  surface: Surface,
): ConversationContentBlock[] {
  const next = [...(blocks ?? [])];
  const existingIdx = next.findIndex(
    (b) => b.type === "surface" && b.surface.surfaceId === surface.surfaceId,
  );
  if (existingIdx === -1) {
    next.push({ type: "surface", surface });
  } else {
    next[existingIdx] = { type: "surface", surface };
  }
  return next;
}

/** Drop the `surface` block matching `surfaceId` from a block projection. */
export function removeSurfaceBlock(
  blocks: ConversationContentBlock[] | undefined,
  surfaceId: string,
): ConversationContentBlock[] | undefined {
  return blocks?.filter(
    (b) => !(b.type === "surface" && b.surface.surfaceId === surfaceId),
  );
}

/**
 * Apply `transform` to every surface on `message`, keeping the positional
 * `surfaces` array and the matching `surface` blocks in `contentBlocks` in
 * lockstep.
 *
 * Returns the same `message` reference when no surface changed, so callers keep
 * their existing identity-based change detection (`prev === next`).
 */
export function mapMessageSurfaces(
  message: DisplayMessage,
  transform: (surface: Surface) => Surface,
): DisplayMessage {
  if (!message.surfaces?.length) {
    return message;
  }

  let changed = false;
  let contentBlocks = message.contentBlocks;
  const surfaces = message.surfaces.map((surface) => {
    const next = transform(surface);
    if (next !== surface) {
      changed = true;
      contentBlocks = upsertSurfaceBlock(contentBlocks, next);
    }
    return next;
  });

  if (!changed) {
    return message;
  }

  return { ...message, surfaces, contentBlocks };
}

/**
 * Keep only the surfaces on `message` for which `keep` returns true, removing
 * the dropped surfaces from the positional `surfaces` array, their
 * `contentOrder` entries, and their `contentBlocks` surface blocks together.
 *
 * Returns the same `message` reference when nothing is dropped.
 */
export function filterMessageSurfaces(
  message: DisplayMessage,
  keep: (surface: Surface) => boolean,
): DisplayMessage {
  if (!message.surfaces?.length) {
    return message;
  }

  const surfaces = message.surfaces.filter(keep);
  if (surfaces.length === message.surfaces.length) {
    return message;
  }

  const removed = new Set(
    message.surfaces.filter((s) => !keep(s)).map((s) => s.surfaceId),
  );
  return {
    ...message,
    surfaces,
    contentOrder: message.contentOrder?.filter(
      (e) => !(e.type === "surface" && removed.has(e.id)),
    ),
    contentBlocks: message.contentBlocks?.filter(
      (b) => !(b.type === "surface" && removed.has(b.surface.surfaceId)),
    ),
  };
}
