import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  findContactByChannelExternalId,
  listGuardianChannels,
} from "../contacts/contact-store.js";
import type {
  ChannelCapabilities,
  TrustContext,
} from "../daemon/conversation-runtime-assembly.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { stripCommentLines } from "./system-prompt.js";

const log = getLogger("persona-resolver");

// ── Types ──────────────────────────────────────────────────────────

export interface PersonaContext {
  userPersona: string | null;
  channelPersona: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Read a persona file from disk, apply comment stripping, and return
 * the content. Returns null if the file does not exist or is empty
 * after stripping.
 */
function readPersonaFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  try {
    const content = stripCommentLines(readFileSync(filePath, "utf-8")).trim();
    if (content.length === 0) return null;
    log.debug({ path: filePath }, "Loaded persona file");
    return content;
  } catch (err) {
    log.warn({ err, path: filePath }, "Failed to read persona file");
    return null;
  }
}

// ── User persona ───────────────────────────────────────────────────

/**
 * Resolve the per-user persona file for the current actor.
 *
 * - If `trustContext` is undefined (desktop/native), looks up the guardian
 *   contact and reads their user file.
 * - If `trustContext` is defined and carries a `requesterExternalUserId`,
 *   looks up the contact by channel + external user ID.
 * - Falls back to `users/default.md` when no contact is found or the
 *   contact has no `userFile` set.
 * - Logs a debug warning when a contact's `userFile` is set but the
 *   corresponding file is missing on disk.
 */
export function resolveUserPersona(
  trustContext: TrustContext | undefined,
): string | null {
  const usersDir = join(getWorkspaceDir(), "users");
  const defaultPath = join(usersDir, "default.md");

  let filename: string | null = null;

  if (trustContext === undefined) {
    // Desktop / native — resolve via guardian contact
    const guardian = listGuardianChannels();
    if (guardian) {
      filename = guardian.contact.userFile ?? null;
    }
  } else if (trustContext.requesterExternalUserId) {
    // Channel-routed request — look up contact by channel identity
    const contactWithChannels = findContactByChannelExternalId(
      trustContext.sourceChannel,
      trustContext.requesterExternalUserId,
    );
    if (contactWithChannels) {
      filename = contactWithChannels.userFile ?? null;
    }
  }

  // Resolve file path — validate basename to prevent path traversal
  if (filename) {
    if (basename(filename) !== filename || filename === ".." || filename === ".") {
      log.warn(
        { userFile: filename },
        "Contact userFile contains path traversal; ignoring",
      );
      return readPersonaFile(defaultPath);
    }
    const filePath = join(usersDir, filename);
    if (existsSync(filePath)) {
      return readPersonaFile(filePath);
    }
    // userFile is set but the file doesn't exist on disk
    log.debug(
      { userFile: filename },
      "Contact has userFile set but file is missing on disk; falling back to default.md",
    );
  }

  // Fall back to default.md
  return readPersonaFile(defaultPath);
}

// ── Channel persona ────────────────────────────────────────────────

/**
 * Resolve the per-channel persona file based on channel capabilities.
 *
 * Reads from `channels/<channel>.md` in the workspace directory.
 * Defaults to `"vellum"` when no channel capabilities are provided.
 * Returns null if the channel file does not exist.
 */
export function resolveChannelPersona(
  channelCapabilities: ChannelCapabilities | undefined,
): string | null {
  const channel = channelCapabilities?.channel ?? "vellum";
  const filePath = join(getWorkspaceDir(), "channels", channel + ".md");
  return readPersonaFile(filePath);
}

// ── Combined resolver ──────────────────────────────────────────────

/**
 * Resolve both user and channel persona context in a single call.
 */
export function resolvePersonaContext(
  trustContext: TrustContext | undefined,
  channelCapabilities: ChannelCapabilities | undefined,
): PersonaContext {
  return {
    userPersona: resolveUserPersona(trustContext),
    channelPersona: resolveChannelPersona(channelCapabilities),
  };
}

// ── Guardian convenience ───────────────────────────────────────────

/**
 * Resolve the guardian's user persona.
 *
 * This is a convenience wrapper for background subsystems that need
 * the guardian's persona without a full trust context. Passing
 * `undefined` triggers the guardian lookup path in `resolveUserPersona`.
 */
export function resolveGuardianPersona(): string | null {
  return resolveUserPersona(undefined);
}
