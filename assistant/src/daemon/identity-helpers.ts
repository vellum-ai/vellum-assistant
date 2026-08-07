import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveGuardianPersonaStrict } from "../prompts/persona-resolver.js";
import { DECLINED_BY_USER_SENTINEL } from "../prompts/user-reference.js";
import { getWorkspacePromptPath } from "../util/platform.js";

/** Read the assistant's name from IDENTITY.md for personalized responses. */
export function getAssistantName(): string | null {
  try {
    const path = getWorkspacePromptPath("IDENTITY.md");
    if (!existsSync(path)) {
      return null;
    }
    const content = readFileSync(path, "utf-8");
    const match = content.match(/\*\*Name:\*\*\s*(.+)/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Extract a display name from persona-file content. Tries the markdown-bold
 * "Name" label (the IDENTITY.md convention), then the onboarding-written
 * "Preferred name" bullet, then the scaffold's "Preferred name/reference"
 * line. Matches only horizontal whitespace after the label so an unfilled
 * scaffold line does not swallow the next line.
 */
function extractPersonaName(content: string): string | null {
  const match =
    content.match(/\*\*Name:\*\*[ \t]*(.+)/) ??
    content.match(/\*\*Preferred name:\*\*[ \t]*(.+)/) ??
    content.match(/Preferred name\/reference:[ \t]*(.+)/);
  return match?.[1]?.trim() || null;
}

function readPersonaName(filePath: string): string | null {
  try {
    return extractPersonaName(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Read the user's display name from the guardian's persona file
 * (`users/<slug>.md`, resolved via the guardian-delivery binding), falling
 * back to `users/default.md`. Returns `null` on any miss; callers substitute
 * a generic label.
 *
 * The guardian resolution reads the sync in-process guardian-delivery cache;
 * callers in processes that do not otherwise warm it (memory worker) await
 * `getGuardianDelivery` first.
 */
export function resolveUserName(workspaceDir: string): string | null {
  const guardianContent = resolveGuardianPersonaStrict();
  if (guardianContent) {
    const name = extractPersonaName(guardianContent);
    if (name && name !== DECLINED_BY_USER_SENTINEL) {
      return name;
    }
  }
  return readPersonaName(join(workspaceDir, "users", "default.md"));
}
