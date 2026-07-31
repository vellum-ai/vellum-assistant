import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceDir } from "../util/platform.js";

/**
 * Update the `## Avatar` section in IDENTITY.md with a plain-text description.
 * If the section doesn't exist, appends it.
 */
export function updateIdentityAvatarSection(
  description: string,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): void {
  const identityPath = join(getWorkspaceDir(), "IDENTITY.md");

  if (!existsSync(identityPath)) {
    log?.warn(
      { identityPath },
      "IDENTITY.md not found, skipping avatar section update",
    );
    return;
  }

  let content: string;
  try {
    content = readFileSync(identityPath, "utf-8");
  } catch (err) {
    log?.warn({ err }, "Failed to read IDENTITY.md");
    return;
  }

  const sectionBody = `## Avatar\n${description}\n`;

  // Match ## Avatar and its content up to (but not including) the next heading
  // at any level, or end of file. Uses multiline ^ to match headings at line start.
  const avatarSectionRegex = /## Avatar\n[\s\S]*?(?=^#{1,6} |\s*$)/m;

  let updated: string;
  if (avatarSectionRegex.test(content)) {
    updated = content.replace(avatarSectionRegex, sectionBody);
  } else {
    // Append the section
    updated = content.trimEnd() + "\n\n" + sectionBody + "\n";
  }

  try {
    writeFileSync(identityPath, updated, "utf-8");
  } catch (err) {
    log?.warn({ err }, "Failed to update IDENTITY.md avatar section");
  }
}
