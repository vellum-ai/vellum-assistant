/**
 * The memory-v3 {@link Injector}. Reads both v3 flags:
 *   - `memory-v3-live` on → orchestrate, log, render the working-set selection
 *     into a `<memory>` block, and return it at v2's dynamic-memory placement.
 *   - `memory-v3-shadow` on (live off) → orchestrate + log only, return `null`.
 *   - both off → return `null` (no orchestration).
 *
 * Empty selection and any failure return `null` (no v3 injection). v2
 * suppression keys off BOTH the flag AND this return value, so a `null` here
 * (failure or empty selection) falls back to v2 memory rather than dropping all
 * memory.
 *
 * Orchestration and telemetry live in {@link observeTurn}; this module is the
 * thin injector wrapper that renders the result for live injection.
 */

import { isAssistantFeatureFlagEnabled } from "../../../config/assistant-feature-flags.js";
import { getConfig } from "../../../config/loader.js";
import { getLogger } from "../../../util/logger.js";
import {
  type InjectionBlock,
  type Injector,
  type TurnContext,
} from "../../types.js";
import { renderV3SectionContent } from "./page-content.js";
import { renderMemoryBlock } from "./render-injection.js";
import {
  MEMORY_V3_LIVE,
  MEMORY_V3_SHADOW,
  observeTurn,
} from "./shadow-plugin.js";
import { MEMORY_V3_BLOCK_ID } from "./types.js";

const log = getLogger("memory-v3-shadow");

export const memoryV3Injector: Injector = {
  name: "memory-v3-shadow",
  // High order so it sorts last; the live `<memory>` block uses the
  // after-memory-prefix placement so it lands at the memory boundary regardless
  // of this sort key, which only orders content-producing injectors.
  order: 1000,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const config = getConfig();
    const live = isAssistantFeatureFlagEnabled(MEMORY_V3_LIVE, config);
    const shadow = isAssistantFeatureFlagEnabled(MEMORY_V3_SHADOW, config);
    if (!live && !shadow) return null;

    const result = await observeTurn(ctx.conversationId, ctx.turnIndex);
    if (!live || !result) return null;

    try {
      // `renderMemoryBlock` returns "" for an empty selection; inject nothing.
      const text = await renderMemoryBlock(
        result.finalInjection,
        result.sectionBySlug,
        renderV3SectionContent,
      );
      if (text.length === 0) return null;
      return {
        id: MEMORY_V3_BLOCK_ID,
        text,
        // Mirror v2's dynamic `<memory>` block placement.
        placement: "after-memory-prefix",
      };
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          conversationId: ctx.conversationId,
        },
        "memory-v3 live render failed (non-fatal) — falling back to v2",
      );
      return null;
    }
  },
};
