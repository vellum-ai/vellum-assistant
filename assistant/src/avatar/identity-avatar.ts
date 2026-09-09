import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { AvatarState } from "@vellumai/avatar-manifest";

import { isTemplateContent } from "../prompts/template-detection.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePromptPath } from "../util/platform.js";

const log = getLogger("identity-avatar");

/** The note left once the avatar is cleared. */
export const NO_AVATAR_IDENTITY_NOTE =
  "Default character avatar (no custom image set)";

/**
 * Longest note written to IDENTITY.md. The note rides in every system prompt,
 * and an AI prompt can run to paragraphs.
 */
export const AVATAR_IDENTITY_NOTE_MAX_CHARS = 240;

/**
 * One line, at most {@link AVATAR_IDENTITY_NOTE_MAX_CHARS} long. A line break
 * would let a description carry its own `## Heading` out of the managed
 * Avatar section.
 */
function toIdentityLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > AVATAR_IDENTITY_NOTE_MAX_CHARS
    ? `${line.slice(0, AVATAR_IDENTITY_NOTE_MAX_CHARS - 3).trimEnd()}...`
    : line;
}

/**
 * A plain-text note on the avatar just written, so the assistant knows what
 * it looks like across sessions even when the change came from a client and
 * no skill ran to describe it. `imageDescription` is what an image shows when
 * the caller knows (the prompt an AI image was generated from).
 */
export function describeAvatarState(
  state: AvatarState,
  imageDescription?: string,
): string {
  if (state.kind === "character" && state.traits) {
    const { color, bodyShape, eyeStyle } = state.traits;
    return `A ${color} ${bodyShape} character with ${eyeStyle} eyes.`;
  }
  if (state.kind === "image" && state.source === "ai") {
    return imageDescription
      ? toIdentityLine(`An AI-generated image: ${imageDescription}`)
      : "An AI-generated image.";
  }
  if (state.kind === "image") {
    return "A custom image the user uploaded.";
  }
  return NO_AVATAR_IDENTITY_NOTE;
}

/**
 * Update the `## Avatar` section in IDENTITY.md with a plain-text description.
 * If the section doesn't exist, appends it. An unmodified template is left
 * alone: template detection gates the bootstrap prompt, the heartbeat's
 * shallow-profile check, and memory's identity context, and the bootstrap
 * turn rewrites the whole file anyway.
 */
export function updateIdentityAvatarSection(description: string): void {
  const identityPath = getWorkspacePromptPath("IDENTITY.md");

  if (!existsSync(identityPath)) {
    log.warn(
      { identityPath },
      "IDENTITY.md not found, skipping avatar section update",
    );
    return;
  }

  let content: string;
  try {
    content = readFileSync(identityPath, "utf-8");
  } catch (err) {
    log.warn({ err }, "Failed to read IDENTITY.md");
    return;
  }

  if (isTemplateContent(content, "IDENTITY.md")) {
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
    log.warn({ err }, "Failed to update IDENTITY.md avatar section");
  }
}
