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
  MEMORY_V3_LEGACY_BLOCK_SUPPRESSIONS_METADATA_KEY,
  normalizeMemoryV3LegacyBlockSuppressions,
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
  strippedLegacyBlocks: ReadonlySet<string>,
  normalizePersistedLegacyBlock: (inner: string) => string,
): Promise<void> {
  const rows = await getMessages(conversationId);
  await Promise.all(
    rows.map(async (row) => {
      const metadata = await parseMessageMetadata(row.metadata);
      const v3Block = metadata?.memoryV3InjectedBlock;
      const v3Inner =
        typeof v3Block === "string" ? unwrapMemoryBlock(v3Block) : "";
      const legacyCardSlugs = Array.isArray(
        metadata?.[MEMORY_V3_CARD_SLUGS_METADATA_KEY],
      )
        ? metadata[MEMORY_V3_CARD_SLUGS_METADATA_KEY].filter(
            (slug): slug is string => typeof slug === "string",
          )
        : undefined;
      const suppressLegacyBlock =
        v3Inner.length > 0 &&
        !parseCardSections(v3Inner).framed &&
        !legacyCardSlugs &&
        (strippedLegacyBlocks.has(v3Inner) ||
          strippedLegacyBlocks.has(normalizePersistedLegacyBlock(v3Inner)));
      const rowIncompatibleIds = [...incompatibleIds].filter((id) =>
        PERSISTED_BLOCK_KEYS.some((key) => {
          const block = metadata?.[key];
          const inner =
            typeof block === "string" ? unwrapMemoryBlock(block) : "";
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
      if (rowIncompatibleIds.length === 0 && !suppressLegacyBlock) {
        return;
      }
      const suppressions = normalizeSkillCardSuppressions(
        metadata?.[SKILL_CARD_SUPPRESSIONS_METADATA_KEY],
      );
      const updates: Record<string, unknown> = {};
      if (rowIncompatibleIds.length > 0) {
        suppressions[conversationId] = [
          ...new Set([
            ...(suppressions[conversationId] ?? []),
            ...rowIncompatibleIds,
          ]),
        ];
        updates[SKILL_CARD_SUPPRESSIONS_METADATA_KEY] = suppressions;
      }
      if (suppressLegacyBlock) {
        const existing =
          metadata?.[MEMORY_V3_LEGACY_BLOCK_SUPPRESSIONS_METADATA_KEY];
        updates[MEMORY_V3_LEGACY_BLOCK_SUPPRESSIONS_METADATA_KEY] = [
          ...new Set([
            ...normalizeMemoryV3LegacyBlockSuppressions(existing),
            conversationId,
          ]),
        ];
      }
      await updateMessageMetadata(row.id, updates);
    }),
  );
}

export async function stripIncompatibleSkillCardsFromMessages(
  messages: Message[],
  context: SkillPlatformContext,
  options: {
    conversationId?: string;
    normalizePersistedLegacyBlock?: (inner: string) => string;
  } = {},
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
  const strippedLegacyBlocks = new Set<string>();
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
      if (!parseCardSections(inner).framed) {
        strippedLegacyBlocks.add(inner);
      }
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
      strippedLegacyBlocks,
      options.normalizePersistedLegacyBlock ?? ((inner) => inner),
    );
  }
  return strippedBlocks;
}
