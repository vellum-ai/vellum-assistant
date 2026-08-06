// Console/terminal output for the nested detail panel. Body-only — the Back +
// breadcrumb live in the chat view's shared header (mirrors FileDiffView).

import { getAcpToolOutputText } from "@/domains/chat/acp-tool-content";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";

export interface CommandOutputViewProps {
  /** Stringified ACP tool content whose text output to render. */
  content?: string;
  /**
   * Assistant that owns the run's parent conversation. Lets workspace file
   * references in the command output resolve against its workspace instead of
   * degrading to an inert file card.
   */
  assistantId?: string | null;
}

export function CommandOutputView({
  content,
  assistantId,
}: CommandOutputViewProps) {
  const output = getAcpToolOutputText(content);
  return (
    <div
      data-testid="acp-chat-command-output"
      // Uncap the markdown code block so the output flows in the panel's own
      // scroll rather than nesting a second scrollbar.
      className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3 [&_pre]:!max-h-none"
    >
      <ChatMarkdownMessage
        content={output}
        hardLineBreaks
        assistantId={assistantId}
      />
    </div>
  );
}
