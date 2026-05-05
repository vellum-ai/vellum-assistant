// ---------------------------------------------------------------------------
// Memory v2 — daemon-startup helpers
// ---------------------------------------------------------------------------
//
// Small focused module that holds the gating + dispatch logic for v2-specific
// startup work invoked from `lifecycle.ts`. Lives in its own file so the unit
// test for the gate does not have to mount the entire lifecycle import graph.

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("memory-v2-startup");

/**
 * Fire-and-forget seed of the v2 skill entries (now indexed alongside concept
 * pages in `memory_v2_concept_pages` under the `skills/<id>` slug prefix), and
 * a one-shot best-effort cleanup of the legacy `memory_v2_skills` Qdrant
 * collection. Gated on both the `memory-v2-enabled` feature flag and the
 * workspace-level `config.memory.v2.enabled` switch so v2 modules stay out of
 * the v1 startup path when v2 is off.
 *
 * Uses a dynamic import so v2 code does not load unless the gate passes.
 * Never awaits — startup must not block on this (see `assistant/CLAUDE.md`
 * daemon startup philosophy).
 */
export function maybeSeedMemoryV2Skills(config: AssistantConfig): void {
  if (
    !isAssistantFeatureFlagEnabled("memory-v2-enabled", config) ||
    !config.memory.v2.enabled
  ) {
    return;
  }
  void import("../memory/v2/skill-store.js")
    .then(({ seedV2SkillEntries }) => seedV2SkillEntries())
    .catch((err) => log.warn({ err }, "Failed to seed v2 skill entries"));
  void import("../memory/v2/qdrant.js")
    .then(({ dropLegacySkillsCollection }) => dropLegacySkillsCollection())
    .catch((err) =>
      log.warn(
        { err },
        "Failed to drop legacy memory_v2_skills collection — non-fatal",
      ),
    );
}
