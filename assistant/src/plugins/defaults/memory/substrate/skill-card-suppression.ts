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
export const MEMORY_V3_CARD_SLUGS_METADATA_KEY = "memoryV3InjectedCardSlugs";

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

function cardHeader(slug: string): string {
  if (slug.startsWith("skills/")) {
    return `# Skill: ${slug.slice("skills/".length)}`;
  }
  if (slug.startsWith("cli-commands/")) {
    return `# CLI command: ${slug.slice("cli-commands/".length)}`;
  }
  return `# memory/concepts/${slug}.md`;
}

function legacyPiecesFromSlugs(
  inner: string,
  slugs: readonly string[],
): { preamble: string; pieces: Array<{ slug: string; text: string }> } | null {
  const boundaries: Array<{ index: number; slug: string }> = [];
  let before = inner.length;
  for (let index = slugs.length - 1; index >= 0; index -= 1) {
    const slug = slugs[index]!;
    const header = cardHeader(slug);
    const atStart = inner.startsWith(header) ? 0 : -1;
    const separated = inner.lastIndexOf(`\n\n${header}`, before - 1);
    const found = separated >= 0 ? separated + 2 : atStart;
    if (found < 0 || found >= before) {
      return null;
    }
    boundaries.unshift({ index: found, slug });
    before = found;
  }
  if (boundaries.length === 0) {
    return null;
  }
  return {
    preamble: inner.slice(0, boundaries[0]!.index).trimEnd(),
    pieces: boundaries.map((boundary, index) => ({
      slug: boundary.slug,
      text: inner.slice(boundary.index, boundaries[index + 1]?.index).trimEnd(),
    })),
  };
}

export function extractFramedCardSlugs(inner: string): string[] | null {
  const parsed = parseCardSections(inner);
  if (!parsed.framed) {
    return null;
  }
  return parsed.pieces.flatMap((piece) => {
    if (piece.kind === "card") {
      return [piece.slug];
    }
    const skillId = extractSkillIdFromV3Card(piece.text);
    if (skillId) {
      return [`skills/${skillId}`];
    }
    const command = piece.text.match(/^# CLI command: ([^\r\n]+)/)?.[1];
    return command ? [`cli-commands/${command}`] : [];
  });
}

export function stripSuppressedSkillCards(
  inner: string,
  suppressedIds: ReadonlySet<string>,
  options: { legacyCardSlugs?: readonly string[] } = {},
): string {
  if (suppressedIds.size === 0) {
    return inner;
  }
  const { preamble, pieces, framed } = parseCardSections(inner);
  if (!framed) {
    const legacy = options.legacyCardSlugs
      ? legacyPiecesFromSlugs(inner, options.legacyCardSlugs)
      : null;
    if (legacy) {
      const kept = legacy.pieces.filter(
        (piece) =>
          !piece.slug.startsWith("skills/") ||
          !suppressedIds.has(piece.slug.slice("skills/".length)),
      );
      return stripV1SkillEntries(
        stripV2SkillSection(
          renderCardSections(
            legacy.preamble,
            kept.map((piece) => ({ kind: "other", text: piece.text })),
            false,
          ),
          suppressedIds,
        ),
        suppressedIds,
      );
    }
    const hasSuppressedLegacyHeader = [...suppressedIds].some((id) =>
      pieces.some((piece) => piece.text.startsWith(`# Skill: ${id}\n`)),
    );
    if (hasSuppressedLegacyHeader) {
      return "";
    }
  }
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
