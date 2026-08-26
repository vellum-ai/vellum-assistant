import {
  type ContentBlock,
  getMessages,
  isSkillCompatibleWithContext,
  type Message,
  parseMessageMetadata,
  type SkillPlatformContext,
  updateMessageMetadata,
} from "@vellumai/plugin-api";

import { unwrapMemoryBlock, wrapMemoryBlock } from "../memory-marker.js";
import { parseCardSections } from "./card-block-sections.js";
import {
  MEMORY_V3_CARD_SLUGS_METADATA_KEY,
  normalizeSkillCardSuppressions,
  SKILL_CARD_SUPPRESSIONS_METADATA_KEY,
  stripSuppressedSkillCards,
} from "./skill-card-suppression.js";
import {
  ensureSkillEntriesAvailable,
  getSkillCapability,
  isSkillSlug,
  listSkillEntries,
} from "./skill-store.js";
import type { EverInjectedEntry } from "./types.js";

const PERSISTED_BLOCK_KEYS = [
  "memoryInjectedBlock",
  "memoryV3InjectedBlock",
] as const;

export function isSkillSlugCompatible(
  slug: string,
  context: SkillPlatformContext,
): boolean {
  if (!isSkillSlug(slug)) {
    return true;
  }
  const skill = getSkillCapability(slug);
  return skill !== null && isSkillCompatibleWithContext(skill, context);
}

export function filterCompatibleEverInjected(
  entries: readonly EverInjectedEntry[],
  context: SkillPlatformContext,
): EverInjectedEntry[] {
  return entries.filter((entry) => isSkillSlugCompatible(entry.slug, context));
}

async function persistIncompatibleSkillSuppressions(
  conversationId: string,
  incompatibleIds: ReadonlySet<string>,
): Promise<void> {
  const rows = await getMessages(conversationId);
  await Promise.all(
    rows.map(async (row) => {
      const metadata = await parseMessageMetadata(row.metadata);
      const rowIncompatibleIds = [...incompatibleIds].filter((id) =>
        PERSISTED_BLOCK_KEYS.some((key) => {
          const block = metadata?.[key];
          const inner =
            typeof block === "string" ? unwrapMemoryBlock(block) : "";
          const legacyCardSlugs = Array.isArray(
            metadata?.[MEMORY_V3_CARD_SLUGS_METADATA_KEY],
          )
            ? metadata[MEMORY_V3_CARD_SLUGS_METADATA_KEY].filter(
                (slug): slug is string => typeof slug === "string",
              )
            : undefined;
          if (
            key === "memoryV3InjectedBlock" &&
            !parseCardSections(inner).framed &&
            !legacyCardSlugs
          ) {
            return false;
          }
          return (
            inner.length > 0 &&
            stripSuppressedSkillCards(inner, new Set([id]), {
              legacyCardSlugs,
            }) !== inner
          );
        }),
      );
      if (rowIncompatibleIds.length === 0) {
        return;
      }
      const suppressions = normalizeSkillCardSuppressions(
        metadata?.[SKILL_CARD_SUPPRESSIONS_METADATA_KEY],
      );
      suppressions[conversationId] = [
        ...new Set([
          ...(suppressions[conversationId] ?? []),
          ...rowIncompatibleIds,
        ]),
      ];
      await updateMessageMetadata(row.id, {
        [SKILL_CARD_SUPPRESSIONS_METADATA_KEY]: suppressions,
      });
    }),
  );
}

export async function stripIncompatibleSkillCardsFromMessages(
  messages: Message[],
  context: SkillPlatformContext,
  options: { conversationId?: string } = {},
): Promise<number> {
  await ensureSkillEntriesAvailable();
  const incompatibleSkills = listSkillEntries().filter(
    (skill) => !isSkillCompatibleWithContext(skill, context),
  );
  if (incompatibleSkills.length === 0) {
    return 0;
  }
  const incompatibleIds = new Set(incompatibleSkills.map((skill) => skill.id));

  let strippedBlocks = 0;
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    let changed = false;
    const content: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type !== "text") {
        content.push(block);
        continue;
      }
      const inner = unwrapMemoryBlock(block.text);
      if (inner === block.text) {
        content.push(block);
        continue;
      }
      const filtered = stripSuppressedSkillCards(inner, incompatibleIds);
      if (filtered === inner) {
        content.push(block);
        continue;
      }
      changed = true;
      strippedBlocks += 1;
      if (filtered.length > 0) {
        content.push({ type: "text", text: wrapMemoryBlock(filtered) });
      }
    }
    if (changed) {
      message.content = content;
    }
  }
  if (options.conversationId && strippedBlocks > 0) {
    await persistIncompatibleSkillSuppressions(
      options.conversationId,
      incompatibleIds,
    );
  }
  return strippedBlocks;
}
