import {
  parseCardSections,
  renderCardSections,
} from "./card-block-sections.js";
import {
  extractSkillIdFromAvailabilityContent,
  extractSkillIdFromV3Card,
} from "./skill-card-format.js";

const V2_SKILLS_HEADER = "### Skills You Can Use\n";
const V1_SKILL_ENTRY_REGEX =
  /^- \[skill\] ([^\r\n]+?) → use skill_load to activate$/gm;
export const SKILL_CARD_SUPPRESSIONS_METADATA_KEY =
  "memorySkillCardSuppressions";

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

function stripV1SkillEntries(
  inner: string,
  incompatibleIds: ReadonlySet<string>,
): string {
  const filtered = inner.replace(
    V1_SKILL_ENTRY_REGEX,
    (entry, skillContent: string) => {
      const skillId = extractSkillIdFromAvailabilityContent(skillContent);
      return skillId && incompatibleIds.has(skillId) ? "" : entry;
    },
  );
  return filtered === inner
    ? inner
    : filtered.replace(/^\n+|\n+$/g, "").replace(/\n{3,}/g, "\n\n");
}

export function stripSuppressedSkillCards(
  inner: string,
  suppressedIds: ReadonlySet<string>,
): string {
  if (suppressedIds.size === 0) {
    return inner;
  }
  const { preamble, pieces, framed } = parseCardSections(inner);
  const kept = pieces.filter((piece) => {
    const skillId = extractSkillIdFromV3Card(piece.text);
    return !skillId || !suppressedIds.has(skillId);
  });
  const withoutV3 =
    kept.length === pieces.length
      ? inner
      : renderCardSections(preamble, kept, framed);
  return stripV1SkillEntries(
    stripV2SkillSection(withoutV3, suppressedIds),
    suppressedIds,
  );
}

export function normalizeSkillCardSuppressions(
  value: unknown,
): Record<string, string[]> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([conversationId, ids]) =>
      Array.isArray(ids)
        ? [
            [
              conversationId,
              ids.filter((id): id is string => typeof id === "string"),
            ],
          ]
        : [],
    ),
  );
}

export function suppressedSkillIdsForConversation(
  metadata: unknown,
  conversationId: string,
): ReadonlySet<string> {
  if (metadata == null || typeof metadata !== "object") {
    return new Set();
  }
  const suppressions = normalizeSkillCardSuppressions(
    (metadata as Record<string, unknown>)[SKILL_CARD_SUPPRESSIONS_METADATA_KEY],
  );
  return new Set(suppressions[conversationId] ?? []);
}
