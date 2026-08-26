import type { Message, SkillPlatformContext } from "@vellumai/plugin-api";

import { stripIncompatibleSkillCardsFromMessages as stripFromSubstrate } from "../substrate/skill-card-compatibility.js";
import { getPrunedSlugs } from "./ever-injected-store.js";
import { filterPrunedCardSections } from "./prune.js";

export function stripIncompatibleSkillCardsFromMessages(
  messages: Message[],
  context: SkillPlatformContext,
  options: { conversationId?: string } = {},
): Promise<number> {
  const prunedSlugs = options.conversationId
    ? getPrunedSlugs(options.conversationId)
    : new Set<string>();
  return stripFromSubstrate(messages, context, {
    ...options,
    normalizePersistedLegacyBlock: (inner) =>
      filterPrunedCardSections(inner, prunedSlugs),
  });
}
