const SKILL_AVAILABILITY_ID_PATTERN =
  /^The ".*" skill \(([^)\r\n]+)\) is available\./;
const V3_SKILL_HEADER = "# Skill: ";

export function renderSkillAvailabilityLead(
  displayName: string,
  id: string,
): string {
  return `The "${displayName}" skill (${id}) is available.`;
}

export function extractSkillIdFromAvailabilityContent(
  content: string,
): string | null {
  return content.match(SKILL_AVAILABILITY_ID_PATTERN)?.[1] ?? null;
}

export function renderV3SkillCard(id: string, content: string): string {
  return `${V3_SKILL_HEADER}${id}\n${content}`;
}

export function extractSkillIdFromV3Card(card: string): string | null {
  if (!card.startsWith(V3_SKILL_HEADER)) {
    return null;
  }
  const lineEnd = card.indexOf("\n");
  return card.slice(V3_SKILL_HEADER.length, lineEnd < 0 ? undefined : lineEnd);
}
