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

/** Parse the core identity fields from IDENTITY.md content. */
export function parseIdentityFields(content: string): IdentityFields {
  const fields: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    const extract = (prefix: string): string | null => {
      if (!lower.startsWith(prefix)) return null;
      const value = trimmed.split(":**").pop()?.trim() ?? null;
      if (value && isTemplatePlaceholder(value)) return null;
      return value;
    };

    const name = extract("- **name:**");
    if (name) {
      fields.name = name;
      continue;
    }
    const role = extract("- **role:**");
    if (role) {
      fields.role = role;
      continue;
    }
    const personality = extract("- **personality:**") ?? extract("- **vibe:**");
    if (personality) {
      fields.personality = personality;
      continue;
    }
    const emoji = extract("- **emoji:**");
    if (emoji) {
      fields.emoji = emoji;
      continue;
    }
    const home = extract("- **home:**");
    if (home) {
      fields.home = home;
      continue;
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
