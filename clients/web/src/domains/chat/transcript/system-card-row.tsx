import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * Standalone system notice for daemon-authored status cards (the /compact,
 * /clean, and summarize-up-to results, flagged `isSystemCard`). Renders as a
 * centered, subdued notice — never as assistant-persona speech: no avatar,
 * no chat bubble, no hover actions.
 */
export function SystemCardRow({ message }: { message: DisplayMessage }) {
  const blockText = (message.contentBlocks ?? [])
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
  const text = blockText || (message.textSegments ?? []).join("\n").trim();
  if (!text) {
    return null;
  }
  return (
    <div data-testid="system-card-row" className="flex justify-center">
      <div className="max-w-full rounded-[var(--radius-lg)] bg-[var(--surface-overlay)] px-4 py-3 text-body-small-default text-[var(--content-secondary)]">
        <ChatMarkdownMessage content={text} hardLineBreaks />
      </div>
    </div>
  );
}
