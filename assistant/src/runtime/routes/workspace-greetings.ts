import { existsSync, readFileSync } from "node:fs";

import { getWorkspacePromptPath } from "../../util/platform.js";

function readWorkspaceFile(name: string): string {
  try {
    const path = getWorkspacePromptPath(name);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Parse the `## Greetings` section from SOUL.md. Returns bullet items as an
 * array of strings, or `null` if the section is missing or empty.
 */
export function parseGreetingsSection(content: string): string[] | null {
  let inSection = false;
  let sectionLevel: number | null = null;
  const greetings: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      if (inSection) {
        if (sectionLevel !== null && level <= sectionLevel) break;
        continue;
      }
      if (level === 2 && /^greetings$/i.test(title)) {
        inSection = true;
        sectionLevel = level;
      }
      continue;
    }
    if (!inSection) continue;
    const bullet = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(trimmed);
    const greeting = bullet?.[1]?.trim();
    if (greeting) {
      greetings.push(greeting);
    }
  }

  return greetings.length > 0 ? greetings : null;
}

export function readWorkspaceGreetings(): string[] | null {
  const soulContent = readWorkspaceFile("SOUL.md");
  if (!soulContent) return null;
  return parseGreetingsSection(soulContent);
}
