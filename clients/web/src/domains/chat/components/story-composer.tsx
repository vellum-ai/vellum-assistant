/**
 * The real `ChatComposer` mounted on story-supplied inputs, for stories whose
 * subject sits on the composer stack (the staged-quotes strip, the channel
 * reference chip). Every required prop is an input the orchestrator hands
 * down, so the shipped component mounts on story-supplied callbacks; nothing
 * here stands in for a value the app derives.
 */

import { useRef } from "react";

import { ChatComposer } from "@/domains/chat/components/chat-composer/chat-composer";

export function StoryComposer() {
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
