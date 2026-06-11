import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * Join ordered text parts into a flat plain-text body.
 *
 * Mirrors the daemon's `joinWithSpacing` (see vellum-assistant
 * `daemon/handlers/shared.ts`): adjacent parts are concatenated, and a single
 * space is inserted between two parts only when neither the end of the left
 * part nor the start of the right part is already whitespace. Keeping the two
 * implementations byte-identical means text derived on the client matches the
 * text the daemon would have produced.
 */
function joinWithSpacing(parts: string[]): string {
  if (parts.length === 0) {
    return "";
  }

  let result = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) {
    const prev = result[result.length - 1];
    const next = parts[i]![0];
    // Only insert a space when neither side already has whitespace.
    if (
      prev &&
      next &&
      prev !== " " &&
      prev !== "\n" &&
      prev !== "\t" &&
      next !== " " &&
      next !== "\n" &&
      next !== "\t"
    ) {
      result += " ";
    }
    result += parts[i];
  }
  return result;
}

/**
 * Derive a message's flat plain-text body from the text blocks of its unified
 * `contentBlocks` projection.
 *
 * `contentBlocks` is the authoritative content projection for every row (built
 * at ingest, in the streaming updaters, and in the fold layer), so reading the
 * plain text from it keeps copy/edit/queue/reconcile consumers aligned with
 * what the transcript renders. Thinking, tool, surface, and attachment blocks
 * carry no body text and are skipped — matching the daemon, which joins only
 * the text parts.
 */
export function messagePlainText(
  message: Pick<DisplayMessage, "contentBlocks"> | undefined,
): string {
  const parts: string[] = [];
  for (const block of message?.contentBlocks ?? []) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return joinWithSpacing(parts);
}
