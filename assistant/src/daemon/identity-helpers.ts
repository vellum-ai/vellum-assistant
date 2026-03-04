import { existsSync, readFileSync } from "node:fs";

import { getWorkspacePromptPath } from "../util/platform.js";

/** Read the assistant's name from IDENTITY.md for personalized responses. */
export function getAssistantName(): string | null {
  try {
    const path = getWorkspacePromptPath("IDENTITY.md");
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf-8");
    const match = content.match(/\*\*Name:\*\*\s*(.+)/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}
