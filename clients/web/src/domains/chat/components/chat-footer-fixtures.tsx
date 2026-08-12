/**
 * The chat footer as `chat-body` builds it, for the stories whose subject has
 * a contract against the composer rather than against itself.
 *
 * Two do. `StagedQuotesStrip` sits directly on the composer, so its `mb-2` is
 * a gap to a real element or it is a gap to nothing. `QuoteReplyBubble`'s
 * touch-mobile dock positions itself by measuring `[data-slot="chat-composer"]`
 * out of the document (`quote-reply-bubble.tsx:52-84`), so with no composer
 * mounted it falls back to `bottom: 8px`: glued to the viewport, a position
 * the app never produces, and rendered identically whether the measurement
 * works or is broken.
 *
 * `ChatColumn` and `ChatComposer` are imported rather than mirrored, so the
 * column's widths and insets and the composer's height reach these stories on
 * their own. The one thing reproduced here is the arrangement: `chat-body.tsx`
 * stacks the footer slots above `{composerSlot}` inside a `ChatColumn` with
 * `pt-1 pb-2 sm:pb-0`, at the bottom of the chat body.
 */

import { useRef, type ReactNode } from "react";

import { ChatColumn } from "@/domains/chat/components/chat-column";
import { ChatComposer } from "@/domains/chat/components/chat-composer/chat-composer";

/**
 * The composer the footer stack actually sits on. Every prop it requires is an
 * input the orchestrator hands down, so the real component mounts on
 * story-supplied callbacks; nothing here stands in for a value the app
 * derives.
 */
function StoryChatComposer() {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  return (
    <ChatComposer
      placeholder="What would you like to do?"
      onSubmit={(event) => event.preventDefault()}
      inputRef={inputRef}
      typingDisabled={false}
      sendDisabled={false}
      onAddAttachmentFiles={() => {}}
      onStopGenerating={() => {}}
      isAssistantBusy={false}
      assistantId={null}
    />
  );
}

interface ChatFooterShellProps {
  /**
   * Stacked above the composer, inside the column, where `chat-body` puts the
   * footer slots.
   */
  children?: ReactNode;
  /**
   * Story harness controls. Rendered below the column and outside it, so a
   * control the app does not ship cannot be mistaken for part of the footer.
   */
  harness?: ReactNode;
}

/** The bottom-anchored chat page: the footer column, on a real composer. */
export function ChatFooterShell({ children, harness }: ChatFooterShellProps) {
  return (
    <div className="flex h-screen flex-col justify-end">
      <ChatColumn className="pt-1 pb-2 sm:pb-0">
        {children}
        <StoryChatComposer />
      </ChatColumn>
      {harness && <div className="px-3 py-3 sm:px-6">{harness}</div>}
    </div>
  );
}
