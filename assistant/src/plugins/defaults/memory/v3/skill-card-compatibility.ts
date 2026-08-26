import type { Message, SkillPlatformContext } from "@vellumai/plugin-api";

import { stripIncompatibleSkillCardsFromMessages as stripFromSubstrate } from "../substrate/skill-card-compatibility.js";
import { getPrunedSlugs } from "./ever-injected-store.js";
import { filterPrunedCardSections } from "./prune.js";

export function stripIncompatibleSkillCardsFromMessages(
  messages: Message[],
  context: SkillPlatformContext,
  options: { conversationId?: string } = {},
): Promise<number> {
  let prunedSlugs = new Set<string>();
  if (options.conversationId) {
    try {
      prunedSlugs = getPrunedSlugs(options.conversationId);
    } catch {
      prunedSlugs = new Set();
    }
  }
  return stripFromSubstrate(messages, context, {
    ...options,
    normalizePersistedLegacyBlock: (inner) =>
      filterPrunedCardSections(inner, prunedSlugs),
  });
}
