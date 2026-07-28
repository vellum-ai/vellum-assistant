/**
 * A user turn in the ACP chat transcript — right-aligned bubble.
 */

export interface AcpChatUserTurnProps {
  /** Plain-text body of the user's message. */
  content: string;
}

export function AcpChatUserTurn({ content }: AcpChatUserTurnProps) {
  return (
    <div
      data-testid="acp-chat-user-turn"
      className="flex w-full justify-end"
    >
      <div className="max-w-[80%] rounded-lg bg-[var(--surface-lift)] px-4 py-3 whitespace-pre-wrap text-chat text-[var(--content-default)]">
        {content}
      </div>
    </div>
  );
}
