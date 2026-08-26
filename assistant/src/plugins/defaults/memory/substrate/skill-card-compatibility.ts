import {
  type ContentBlock,
  isSkillCompatibleWithContext,
  type Message,
  type SkillPlatformContext,
} from "@vellumai/plugin-api";

import { unwrapMemoryBlock, wrapMemoryBlock } from "../memory-marker.js";
import {
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
  incompatibleContents: readonly string[],
): string {
  const start = inner.indexOf(V2_SKILLS_HEADER);
  if (start < 0) {
    return inner;
  }
  const bodyStart = start + V2_SKILLS_HEADER.length;
  const nextSection = inner.indexOf("\n\n### ", bodyStart);
  const end = nextSection < 0 ? inner.length : nextSection;
  let body = inner.slice(bodyStart, end);
  for (const content of incompatibleContents) {
    body = body.replace(`- ${content} → use skill_load to activate`, "");
  }
  body = body.trim();
  const before = inner.slice(0, start).trimEnd();
  const after = inner.slice(end).trimStart();
  return [before, body ? `${V2_SKILLS_HEADER}${body}` : "", after]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function stripIncompatibleSkillsFromInner(
  inner: string,
  incompatibleSkills: ReadonlyArray<{ id: string; content: string }>,
): string {
  const v3Chunks = new Set(
    incompatibleSkills.map((skill) => `# Skill: ${skill.id}\n${skill.content}`),
  );
  const withoutV3 = inner
    .split("\n\n")
    .filter((piece) => !v3Chunks.has(piece))
    .join("\n\n");
  return stripV2SkillSection(
    withoutV3,
    incompatibleSkills.map((skill) => skill.content),
  );
}

export function stripIncompatibleSkillCardsFromMessages(
  messages: Message[],
  context: SkillPlatformContext,
): number {
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
