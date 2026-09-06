/**
 * The message-metadata update the user-prompt-submit hook writes onto the
 * turn's user row once runtime assembly has produced the turn's injection
 * blocks: pure, so the persisted layout of a turn (and of a retried turn,
 * which re-runs onto its original anchor row) can be derived in a test from
 * the same blocks.
 */

import type { RuntimeInjectionResult } from "../../../../daemon/conversation-runtime-assembly.js";
import {
  MEMORY_V3_INJECTED_BLOCK_FORMAT,
  MEMORY_V3_INJECTED_BLOCK_FORMAT_METADATA_KEY,
  MEMORY_V3_INJECTED_BLOCK_METADATA_KEY,
} from "../v3/ever-injected-store.js";
import {
  LEGACY_MEMORY_V3_SPOTLIGHT_BLOCK_METADATA_KEY,
  MEMORY_V3_POINTER_BLOCK_METADATA_KEY,
} from "../v3/types.js";

/** The blocks persisted verbatim, each under its own metadata key, in the
 *  order the update writes them. */
const PASSTHROUGH_BLOCKS: ReadonlyArray<
  readonly [block: keyof RuntimeInjectionResult["blocks"], key: string]
> = [
  ["unifiedTurnContext", "turnContextBlock"],
  ["pkbSystemReminder", "pkbSystemReminderBlock"],
  ["workspaceBlock", "workspaceBlock"],
  ["nowScratchpadBlock", "nowScratchpadBlock"],
  ["pkbContextBlock", "pkbContextBlock"],
  ["memoryV2StaticBlock", "memoryV2StaticBlock"],
  ["backgroundTurnBlock", "backgroundTurnBlock"],
  ["channelCapabilitiesBlock", "channelCapabilitiesBlock"],
  ["nonInteractiveContextBlock", "nonInteractiveContextBlock"],
];

/**
 * The combined metadata update for a turn's assembled blocks, or `null` when
 * the turn has nothing to persist. Every present block is written under its
 * key in one update. The memory layers end the turn mutually exclusive per
 * row and, on a retry, exactly as the rerun assembled them:
 *
 *  - v2's block (`memoryInjectedBlock`) was persisted right after retrieval.
 *    When memory-v3 superseded it this turn (`blocks.memoryV3Active`),
 *    assembly stripped the v2 block from the tail, so the update REMOVES the
 *    key again (persisting it would rehydrate a block that is not in the
 *    live history). `v2BlockPersisted` says whether there is anything to
 *    remove.
 *  - `blocks.memoryV3InjectedBlock` (the frozen net-new section block,
 *    unwrapped) persists under `MEMORY_V3_INJECTED_BLOCK_METADATA_KEY` with
 *    `MEMORY_V3_INJECTED_BLOCK_FORMAT` stamped beside it (the value the
 *    readers compare to tell a section block from a legacy card block),
 *    only when the turn rendered net-new sections: an all-repeat rerun
 *    leaves the anchor's frozen block in place.
 *  - `blocks.memoryV3PointerBlock` (the wrapped `<memory_pointer>` that was
 *    sent) persists under `MEMORY_V3_POINTER_BLOCK_METADATA_KEY`; a turn
 *    without a pointer DELETES the key, and the legacy
 *    `memoryV3SpotlightBlock` key is always deleted. `/conversations/:id/retry`
 *    re-runs a turn onto its original anchor row after a reload, and assembly
 *    strips the anchor's old pointer and spotlight from the tail before
 *    re-injecting, so a stale key left in the metadata would restore a
 *    pointer or spotlight the rerun discarded on the next load. On a fresh
 *    row the deletions are no-ops.
 *
 * An `undefined` value deletes its key in `updateMessageMetadata`'s merge
 * (`JSON.stringify` drops it); the metadata schema types these fields
 * `string | absent`, so removal drops the key rather than writing null.
 * Nothing is persisted (`null`) only when the turn produced no block, has no
 * v2 key to remove, and memory-v3 was not the turn's memory layer.
 */
export function injectionMetadataUpdates(
  blocks: RuntimeInjectionResult["blocks"],
  v2BlockPersisted: boolean,
): Record<string, unknown> | null {
  const updates: Record<string, unknown> = {};
  if (blocks.memoryV3Active && v2BlockPersisted) {
    updates.memoryInjectedBlock = undefined;
  }
  if (blocks.memoryV3InjectedBlock) {
    updates[MEMORY_V3_INJECTED_BLOCK_METADATA_KEY] =
      blocks.memoryV3InjectedBlock;
    updates[MEMORY_V3_INJECTED_BLOCK_FORMAT_METADATA_KEY] =
      MEMORY_V3_INJECTED_BLOCK_FORMAT;
  }
  if (blocks.memoryV3PointerBlock) {
    updates[MEMORY_V3_POINTER_BLOCK_METADATA_KEY] = blocks.memoryV3PointerBlock;
  }
  for (const [block, key] of PASSTHROUGH_BLOCKS) {
    if (blocks[block]) {
      updates[key] = blocks[block];
    }
  }
  if (Object.keys(updates).length === 0 && !blocks.memoryV3Active) {
    return null;
  }
  if (!blocks.memoryV3PointerBlock) {
    updates[MEMORY_V3_POINTER_BLOCK_METADATA_KEY] = undefined;
  }
  updates[LEGACY_MEMORY_V3_SPOTLIGHT_BLOCK_METADATA_KEY] = undefined;
  return updates;
}
