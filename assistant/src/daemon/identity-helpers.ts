import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Read the guardian's display name from `users/default.md`. We look for the
 * markdown-bold "Name" label (matching the IDENTITY.md convention) and fall
 * back to `null` on any miss; callers substitute a generic label.
 */
export function resolveUserName(workspaceDir: string): string | null {
  try {
    const content = readFileSync(
      join(workspaceDir, "users", "default.md"),
      "utf-8",
    );
    const match = content.match(/\*\*Name:\*\*\s*(.+)/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}
