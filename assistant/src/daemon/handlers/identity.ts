/**
 * Returns true when the value is a template placeholder that should be treated
 * as empty/unset. Placeholders follow the pattern `_(…)_`, e.g.
 * `_(not yet chosen)_` or `_(not yet established)_`.
 */
export function isTemplatePlaceholder(value: string): boolean {
  return value.startsWith("_(") && value.endsWith(")_");
}

export interface IdentityFields {
  name: string;
  role: string;
  personality: string;
  emoji: string;
  home: string;
}

/**
 * Matches prose-style identity patterns that don't use the strict
 * `- **field:** value` bullet format.
 *
 * Currently supported fallback patterns:
 *  - `**field:** value` (bold label without leading dash)
 *  - For the `name` field only: `I'm [Name]` or `My name is [Name]`
 *
 * Returns the extracted value or null if no pattern matches for the given field.
 */
function extractProseField(line: string, field: "name" | "role" | "personality" | "vibe" | "emoji" | "home"): string | null {
  const trimmed = line.trim();
  const lower = trimmed.toLowerCase();
  const fieldKey = field === "vibe" ? "personality" : field;

  // Pattern 1: **field:** value (bold label without dash)
  // Supports both `**Name:** Jophiel` (colon inside bold) and `**Name**: Jophiel` (colon outside)
  const boldMatch = trimmed.match(/^\*\*(.+?)\*\*\s*(.*)$/);
  if (boldMatch) {
    const label = boldMatch[1]!.replace(/:+\s*$/, "").trim().toLowerCase();
    const value = boldMatch[2]!.trim();
    if (
      label === fieldKey ||
      label === fieldKey.toLowerCase() ||
      (field === "vibe" && label === "vibe") ||
      (field === "personality" && label === "personality")
    ) {
      if (value && isTemplatePlaceholder(value)) return null;
      return value;
    }
  }

  // Pattern 2: I'm [Name] or My name is [Name] (name only)
  if (field === "name") {
    const imMatch = trimmed.match(/^(?:I'm|I am|My name is)\s+(.+?)[.!]?$/i);
    if (imMatch) {
      const value = imMatch[1]!.trim();
      if (value && isTemplatePlaceholder(value)) return null;
      return value;
    }
  }

  return null;
}

/** Parse the core identity fields from IDENTITY.md content. */
export function parseIdentityFields(content: string): IdentityFields {
  const fields: Partial<Record<"name" | "role" | "personality" | "emoji" | "home", string>> = {};
  const allFields = ["name", "role", "personality", "emoji", "home"] as const;
  const seenFields = new Set<string>();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();

    // --- Primary: strict `- **field:** value` bullet format ---
    const extractBullet = (prefix: string): string | null => {
      if (!lower.startsWith(prefix)) return null;
      const value = trimmed.split(":**").pop()?.trim() ?? null;
      if (value && isTemplatePlaceholder(value)) return null;
      return value;
    };

    // Check all bullet fields
    for (const field of allFields) {
      const label = `- **${field}:**`;
      const value = extractBullet(label);
      if (value) {
        fields[field] = value;
        seenFields.add(field);
        break;
      }
    }
    // Special case: `- **vibe:**` maps to personality
    const vibe = extractBullet("- **vibe:**");
    if (vibe && !seenFields.has("personality")) {
      fields.personality = vibe;
      seenFields.add("personality");
    }

    // If no bullet match, try prose fallbacks for unsolved fields
    if (seenFields.size < allFields.length) {
      for (const field of allFields) {
        if (seenFields.has(field)) continue;
        const proseValue = extractProseField(trimmed, field);
        if (proseValue) {
          fields[field] = proseValue;
          seenFields.add(field);
        }
      }
      // Check vibe→personality in prose too
      if (!seenFields.has("personality")) {
        const proseVibe = extractProseField(trimmed, "vibe");
        if (proseVibe) {
          fields.personality = proseVibe;
          seenFields.add("personality");
        }
      }
    }
  }

  return {
    name: fields.name ?? "",
    role: fields.role ?? "",
    personality: fields.personality ?? "",
    emoji: fields.emoji ?? "",
    home: fields.home ?? "",
  };
}
