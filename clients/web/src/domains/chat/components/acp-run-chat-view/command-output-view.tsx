// Console/terminal output for the nested detail panel. Body-only — the Back +
// breadcrumb live in the chat view's shared header (mirrors FileDiffView).

import { getAcpToolOutputText } from "@/domains/chat/acp-tool-content";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";

export interface CommandOutputViewProps {
  /** Stringified ACP tool content whose text output to render. */
  content?: string;
}

export function CommandOutputView({ content }: CommandOutputViewProps) {
  const output = getAcpToolOutputText(content);
  return (
    <div
      data-testid="acp-chat-command-output"
      // Uncap the markdown code block so the output flows in the panel's own
      // scroll rather than nesting a second scrollbar.
      className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3 [&_pre]:!max-h-none"
    >
      <ChatMarkdownMessage content={output} hardLineBreaks />
    </div>
  );
}
