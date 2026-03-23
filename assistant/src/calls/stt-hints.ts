import { findContactByAddress, listContacts } from "../contacts/contact-store.js";
import { getAssistantName } from "../daemon/identity-helpers.js";
import { DEFAULT_USER_REFERENCE, resolveGuardianName } from "../prompts/user-reference.js";
import { getLogger } from "../util/logger.js";

const logger = getLogger("stt-hints");

export interface SttHintsInput {
  staticHints: string[];
  assistantName: string | null;
  guardianName: string | null;
  taskDescription: string | null;
  targetContactName: string | null;
  callerContactName: string | null;
  inviteFriendName: string | null;
  inviteGuardianName: string | null;
  recentContactNames: string[];
}

const MAX_HINTS_LENGTH = 500;

/**
 * Assemble STT vocabulary hints from multiple sources into a single
 * comma-separated string suitable for speech-to-text provider hint APIs.
 *
 * Pure function — no DB or filesystem dependencies.
 */
export function buildSttHints(input: SttHintsInput): string {
  const hints: string[] = [...input.staticHints];

  if (input.assistantName != null && input.assistantName.trim().length > 0) {
    hints.push(input.assistantName.trim());
  }

  if (
    input.guardianName != null &&
    input.guardianName.trim().length > 0 &&
    input.guardianName.trim() !== DEFAULT_USER_REFERENCE
  ) {
    hints.push(input.guardianName.trim());
  }

  if (input.inviteFriendName != null && input.inviteFriendName.trim().length > 0) {
    hints.push(input.inviteFriendName.trim());
  }

  if (input.inviteGuardianName != null && input.inviteGuardianName.trim().length > 0) {
    hints.push(input.inviteGuardianName.trim());
  }

  if (input.targetContactName != null && input.targetContactName.trim().length > 0) {
    hints.push(input.targetContactName.trim());
  }

  if (input.callerContactName != null && input.callerContactName.trim().length > 0) {
    hints.push(input.callerContactName.trim());
  }

  // Extract potential proper nouns from task description.
  // Split on sentence boundaries, then for each sentence take words
  // after the first that start with an uppercase letter.
  if (input.taskDescription != null && input.taskDescription.trim().length > 0) {
    const sentences = input.taskDescription.split(/[.!?]\s+/);
    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/);
      // Skip the first word (always capitalized at sentence start)
      for (let i = 1; i < words.length; i++) {
        const word = words[i].replace(/[^a-zA-Z'-]/g, "");
        if (word.length > 0 && /^[A-Z]/.test(word)) {
          hints.push(word);
        }
      }
    }
  }

  hints.push(...input.recentContactNames);

  // Deduplicate (case-insensitive), filter empty/whitespace-only, trim each
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const hint of hints) {
    const trimmed = hint.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(trimmed);
  }

  const joined = deduped.join(",");

  if (joined.length <= MAX_HINTS_LENGTH) {
    return joined;
  }

  // Truncate at the last comma before the limit to avoid partial words
  const truncated = joined.slice(0, MAX_HINTS_LENGTH);
  const lastComma = truncated.lastIndexOf(",");
  if (lastComma === -1) {
    // Single hint that exceeds the limit — return it truncated
    return truncated;
  }
  return truncated.slice(0, lastComma);
}

/**
 * Wire real data sources (contacts DB, identity helpers, config) into
 * {@link buildSttHints}. All DB lookups are best-effort — errors are
 * logged but never propagate so hints can never fail a call.
 */
export function resolveCallHints(
  session: {
    task: string | null;
    toNumber: string;
    fromNumber: string;
    inviteFriendName: string | null;
    inviteGuardianName: string | null;
  } | null,
  staticHints: string[],
): string {
  const assistantName = getAssistantName();
  const guardianName = resolveGuardianName();

  let targetContactName: string | null = null;
  let callerContactName: string | null = null;
  let recentContactNames: string[] = [];

  try {
    if (session) {
      const targetContact = findContactByAddress("phone", session.toNumber);
      if (targetContact) {
        targetContactName = targetContact.displayName;
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to look up target contact for STT hints");
  }

  try {
    if (session) {
      const callerContact = findContactByAddress("phone", session.fromNumber);
      if (callerContact) {
        callerContactName = callerContact.displayName;
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to look up caller contact for STT hints");
  }

  try {
    const recentContacts = listContacts(15);
    recentContactNames = recentContacts.map((c) => c.displayName);
  } catch (err) {
    logger.warn({ err }, "Failed to list recent contacts for STT hints");
  }

  return buildSttHints({
    staticHints,
    assistantName,
    guardianName,
    taskDescription: session?.task ?? null,
    targetContactName,
    callerContactName,
    inviteFriendName: session?.inviteFriendName ?? null,
    inviteGuardianName: session?.inviteGuardianName ?? null,
    recentContactNames,
  });
}
