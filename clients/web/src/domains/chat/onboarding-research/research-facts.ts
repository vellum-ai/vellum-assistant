/**
 * Chat-domain entry point for the research-fact parser.
 *
 * SPIKE — research-onboarding flow.
 *
 * The streaming-tolerant `{ claims, suggestions }` parser and its types now
 * live at `@/utils/research-facts` so the import-banned onboarding domain can
 * share them (the in-flow research steps render the same contract). This module
 * re-exports that surface unchanged for existing chat-domain importers and adds
 * the two helpers that depend on the chat-domain `DisplayMessage` type and so
 * can't live in the neutral util.
 */

import type { DisplayMessage } from "@/domains/chat/types/types";

export {
  REMOVAL_REASON_LABELS,
  confidenceBadge,
  domainFromUrl,
  parseResearchResultStreaming,
} from "@/utils/research-facts";
export type {
  RemovalReason,
  ResearchConfidence,
  ResearchFact,
  ResearchResult,
  ResearchSuggestion,
} from "@/utils/research-facts";

/** Flatten a transcript message to its plain text (text blocks, then legacy segments). */
export function extractMessageText(message: DisplayMessage): string {
  const blocks = message.contentBlocks;
  if (blocks && blocks.length > 0) {
    const text = blocks
      .filter(
        (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return (message.textSegments ?? []).join("\n").trim();
}

/** The latest non-user (assistant) message in the transcript, or null. */
export function latestAssistantMessage(
  messages: DisplayMessage[],
): DisplayMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role !== "user") return m;
  }
  return null;
}
