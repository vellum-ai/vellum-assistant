/**
 * The real `ChatComposer` mounted on story-supplied inputs, for stories whose
 * subject sits on the composer stack (the staged-quotes strip, the channel
 * reference chip). Every required prop is an input the orchestrator hands
 * down, so the shipped component mounts on story-supplied values; nothing
 * here stands in for a value the app derives. The placeholder is one of those
 * inputs: it is fixture copy, so it lives in the story files (which the
 * untranslated-strings lint exempts), not here.
 */

import { useRef } from "react";

import { ChatComposer } from "@/domains/chat/components/chat-composer/chat-composer";

export function StoryComposer({ placeholder }: { placeholder: string }) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  return (
    <ChatComposer
      placeholder={placeholder}
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
