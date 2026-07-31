import type { ConversationMessage } from "@vellumai/assistant-api";

/**
 * Latest assistant reply text from a messages list (joined text blocks).
 *
 * Reads the wire `contentBlocks` projection directly: onboarding flows only
 * ever poll a freshly created assistant, so the pre-0.8.8 positional-array
 * reconstruction in `chat/api/messages.ts` is never needed here.
 */
export function latestAssistantText(messages: ConversationMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") {
      continue;
    }
    return (m.contentBlocks ?? [])
      .filter(
        (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}
