import {
  type ContentBlock,
  isSkillCompatibleWithContext,
  type Message,
  type SkillPlatformContext,
} from "@vellumai/plugin-api";

import { unwrapMemoryBlock, wrapMemoryBlock } from "../memory-marker.js";
import {
  parseCardSections,
  renderCardSections,
} from "./card-block-sections.js";
import {
  extractSkillIdFromAvailabilityContent,
  extractSkillIdFromV3Card,
} from "./skill-card-format.js";
import {
  ensureSkillEntriesAvailable,
  getSkillCapability,
  isSkillSlug,
  listSkillEntries,
} from "./skill-store.js";
import type { EverInjectedEntry } from "./types.js";

const V2_SKILLS_HEADER = "### Skills You Can Use\n";

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

function stripV2SkillSection(
  inner: string,
  incompatibleIds: ReadonlySet<string>,
): string {
  const start = inner.indexOf(V2_SKILLS_HEADER);
  if (start < 0) {
    return inner;
  }
  const bodyStart = start + V2_SKILLS_HEADER.length;
  const nextSection = inner.indexOf("\n\n### ", bodyStart);
  const end = nextSection < 0 ? inner.length : nextSection;
  let body = inner.slice(bodyStart, end);
  body = body.replace(
    /^- ([\s\S]*?) → use skill_load to activate$/gm,
    (entry, skillContent: string) => {
      const skillId = extractSkillIdFromAvailabilityContent(skillContent);
      return skillId && incompatibleIds.has(skillId) ? "" : entry;
    },
  );
  body = body.trim();
  const before = inner.slice(0, start).trimEnd();
  const after = inner.slice(end).trimStart();
  return [before, body ? `${V2_SKILLS_HEADER}${body}` : "", after]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function stripIncompatibleSkillsFromInner(
  inner: string,
  incompatibleSkills: ReadonlyArray<{ id: string }>,
): string {
  const incompatibleIds = new Set(incompatibleSkills.map((skill) => skill.id));
  const { preamble, pieces, framed } = parseCardSections(inner);
  const kept = pieces.filter((piece) => {
    const skillId = extractSkillIdFromV3Card(piece.text);
    return !skillId || !incompatibleIds.has(skillId);
  });
  const withoutV3 =
    kept.length === pieces.length
      ? inner
      : !framed
        ? ""
        : renderCardSections(preamble, kept, true);
  return stripV2SkillSection(withoutV3, incompatibleIds);
}

export async function stripIncompatibleSkillCardsFromMessages(
  messages: Message[],
  context: SkillPlatformContext,
): Promise<number> {
  await ensureSkillEntriesAvailable();
  const incompatibleSkills = listSkillEntries().filter(
    (skill) => !isSkillCompatibleWithContext(skill, context),
  );
  if (incompatibleSkills.length === 0) {
    return 0;
  }

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
      const filtered = stripIncompatibleSkillsFromInner(
        inner,
        incompatibleSkills,
      );
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
  return strippedBlocks;
}
