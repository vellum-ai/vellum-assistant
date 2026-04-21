import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  findContactByChannelExternalId,
  findGuardianForChannel,
  listGuardianChannels,
} from "../contacts/contact-store.js";
import type {
  ChannelCapabilities,
  TrustContext,
} from "../daemon/conversation-runtime-assembly.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";

const log = getLogger("persona-resolver");

// ── Guardian persona template ─────────────────────────────────────
//
// Scaffold written to `users/<slug>.md` when a guardian is resolved
// but no per-user persona file yet exists. Kept in sync with the
// legacy workspace USER.md template so that upgrading users preserve
// the same editable shape. Exported so consumers can detect the
// unmodified scaffold (e.g. heartbeat's `isShallowProfile`).
export const GUARDIAN_PERSONA_TEMPLATE = `_ Lines starting with _ are comments - they won't appear in the system prompt

# User Profile

Store details about your user here. Edit freely - build this over time as you learn about them. Don't be pushy about seeking details, but when you learn something, write it down. More context makes you more useful.

- Preferred name/reference:
- Pronouns:
- Locale:
- Work role:
- Goals:
- Hobbies/fun:
- Daily tools:
`;

// ── Types ──────────────────────────────────────────────────────────

export interface PersonaContext {
  userPersona: string | null;
  userSlug: string | null;
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

// ── User filename resolution ──────────────────────────────────────

/**
 * Resolve the raw userFile filename for the current actor's contact.
 * Returns the validated filename (e.g. "alice.md") or null.
 */
function resolveUserFilename(
  trustContext: TrustContext | undefined,
): string | null {
  let filename: string | null = null;

  if (trustContext === undefined) {
    // Desktop / native (no gateway) — resolve via guardian contact,
    // preferring the vellum-channel guardian when multiple exist.
    const vellumGuardian = findGuardianForChannel("vellum");
    const guardian = vellumGuardian ?? listGuardianChannels();
    if (guardian) {
      filename = guardian.contact.userFile ?? "guardian.md";
    }
  } else if (trustContext.requesterExternalUserId) {
    // Channel-routed request — look up contact by channel identity
    const contactWithChannels = findContactByChannelExternalId(
      trustContext.sourceChannel,
      trustContext.requesterExternalUserId,
    );
    if (contactWithChannels) {
      filename = contactWithChannels.userFile ?? null;
    } else if (trustContext.trustClass === "guardian") {
      // Managed desktop: the JWT principal ID used as requesterExternalUserId
      // may differ from the contact channel's external_user_id (they are
      // separate identity concepts). Fall back to the channel-type guardian.
      const guardian = findGuardianForChannel(trustContext.sourceChannel);
      if (guardian) {
        filename = guardian.contact.userFile ?? "guardian.md";
      }
    }
  }

  // Validate basename to prevent path traversal
  if (filename) {
    if (basename(filename) !== filename || filename === ".." || filename === ".") {
      log.warn(
        { userFile: filename },
        "Contact userFile contains path traversal; ignoring",
      );
      return null;
    }
    return filename;
  }

  return null;
}

/**
 * Resolve the absolute on-disk path to the guardian's per-user persona
 * file (e.g. `<workspace>/users/alice.md`). Returns `null` when no
 * guardian is resolvable (no guardian contact, or its `userFile` is
 * unusable / fails basename validation).
 *
 * This does not check whether the file exists — it only resolves the
 * path. Callers use it alongside `ensureGuardianPersonaFile` to open
 * or scaffold the file.
 */
export function resolveGuardianPersonaPath(): string | null {
  const filename = resolveUserFilename(undefined);
  if (!filename) return null;
  return join(getWorkspaceDir(), "users", filename);
}

/**
 * Resolve a short slug identifying the current user, derived from
 * their contact's userFile. Used to scope per-user workspace directories
 * (e.g. journal/{slug}/). Returns null when no user is identified.
 */
export function resolveUserSlug(
  trustContext: TrustContext | undefined,
): string | null {
  const filename = resolveUserFilename(trustContext);
  if (!filename) return null;
  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
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

  const filename = resolveUserFilename(trustContext);
  if (filename) {
    const filePath = join(usersDir, filename);
    if (existsSync(filePath)) {
      return readPersonaFile(filePath);
    }
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
    userSlug: resolveUserSlug(trustContext),
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

/**
 * Resolve the guardian's user persona strictly from their own
 * `users/<slug>.md` file, with NO fallback to `users/default.md`.
 *
 * Returns `null` when no guardian contact is resolvable, the
 * guardian's userFile is unset, or the file is missing / empty.
 *
 * Used by callers that derive guardian-specific attributes (name,
 * pronouns) where `default.md` content would incorrectly override an
 * intentional caller-supplied fallback such as `Contact.displayName`.
 * System-prompt callers that want the default.md fallback should
 * continue to use `resolveGuardianPersona`.
 */
export function resolveGuardianPersonaStrict(): string | null {
  const filename = resolveUserFilename(undefined);
  if (!filename) return null;
  const filePath = join(getWorkspaceDir(), "users", filename);
  if (!existsSync(filePath)) return null;
  return readPersonaFile(filePath);
}

/**
 * Write the guardian persona template scaffold to `users/<userFile>`
 * when the file does not yet exist. No-op when the file already
 * exists (safe against clobbering user edits).
 *
 * @param userFile - A filename (not a bare slug), matching the shape
 *   of `Contact.userFile` — a basename with a `.md` suffix
 *   (e.g. `"alice.md"`). The path traversal guard rejects values that
 *   are not a clean basename.
 *
 * Creates the parent `users/` directory if missing.
 */
export function ensureGuardianPersonaFile(userFile: string): void {
  if (basename(userFile) !== userFile || userFile === ".." || userFile === ".") {
    log.warn(
      { userFile },
      "Guardian persona userFile contains path traversal; refusing to write",
    );
    return;
  }

  const filePath = join(getWorkspaceDir(), "users", userFile);
  if (existsSync(filePath)) return;

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, GUARDIAN_PERSONA_TEMPLATE, "utf-8");
  log.debug({ path: filePath }, "Wrote guardian persona scaffold");
}

/**
 * Return `true` when the persona file at `filePath` has been edited by
 * the user (its stripped content differs from the bare scaffold
 * template). Returns `false` when the file is missing, unreadable,
 * empty after stripping, or byte-identical to the template after
 * stripping comment lines.
 *
 * Used by the vbundle importer to decide whether a legacy
 * `prompts/USER.md` entry may safely overwrite `users/<slug>.md`.
 */
export function isGuardianPersonaCustomized(filePath: string): boolean {
  if (!existsSync(filePath)) return false;

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    log.warn(
      { err, path: filePath },
      "Failed to read persona file while checking customization",
    );
    return false;
  }

  const stripped = stripCommentLines(content);
  if (stripped.length === 0) return false;

  const templateStripped = stripCommentLines(GUARDIAN_PERSONA_TEMPLATE);
  return stripped !== templateStripped;
}
