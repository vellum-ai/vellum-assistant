import { DEFAULT_USER_REFERENCE } from "../prompts/user-reference.js";

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
 *
 * Dormant: the `calls.voice.hints` config key supplies static hints, but
 * no daemon transcriber consumes the assembled string yet.
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

  if (
    input.inviteFriendName != null &&
    input.inviteFriendName.trim().length > 0
  ) {
    hints.push(input.inviteFriendName.trim());
  }

  if (
    input.inviteGuardianName != null &&
    input.inviteGuardianName.trim().length > 0
  ) {
    hints.push(input.inviteGuardianName.trim());
  }

  if (
    input.targetContactName != null &&
    input.targetContactName.trim().length > 0
  ) {
    hints.push(input.targetContactName.trim());
  }

  if (
    input.callerContactName != null &&
    input.callerContactName.trim().length > 0
  ) {
    hints.push(input.callerContactName.trim());
  }

  // Extract potential proper nouns from task description.
  // Split on sentence boundaries, then for each sentence take words
  // after the first that start with an uppercase letter.
  if (
    input.taskDescription != null &&
    input.taskDescription.trim().length > 0
  ) {
    // Split on sentence-ending punctuation followed by whitespace, but avoid
    // splitting on periods after common abbreviations (Dr., Mr., etc.) so that
    // names like "Dr. Smith" aren't fragmented and dropped by the first-word skip.
    const sentences = input.taskDescription.split(
      /(?<!\b(?:Mr|Mrs|Ms|Dr|Jr|Sr|St|Rev|Prof|Gen|Sgt|Lt|Col))[.]\s+|[!?]\s+/,
    );
    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/);
      // Skip the first word (always capitalized at sentence start)
      for (let i = 1; i < words.length; i++) {
        // Use Unicode-aware \p{L} to preserve accented/non-Latin letters (José, Łukasz, etc.)
        const word = words[i].replace(/[^\p{L}'-]/gu, "");
        if (word.length > 0 && /^\p{Lu}/u.test(word)) {
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
