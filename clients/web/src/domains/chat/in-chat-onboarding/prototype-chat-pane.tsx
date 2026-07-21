import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { ChatComposer } from "@/domains/chat/components/chat-composer/chat-composer";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";

const STREAM_TICK_MS = 24;
const STREAM_CHUNK_CHARS = 3;
/** Beat between a user send and the canned reply starting to stream. */
const REPLY_DELAY_MS = 650;
/** Beat after mount before the kickoff message starts streaming. */
const KICKOFF_DELAY_MS = 500;

/** The post-onboarding opener — streams in as soon as the pane mounts, as if
 *  the onboarding flow's first message was just sent. */
const KICKOFF_MESSAGE =
  "We're all set! While we talked I set up my side of things — a home for our chats, my memory, and a few starter skills. From here on, this is where we work together. First order of business: what should we dig into today?";

const CANNED_REPLIES = [
  "Love it — I'll get a feel for that as we go. What else is on your plate this week?",
  "Noted! I can also handle things proactively — reminders, morning summaries, that kind of thing. Want me to?",
  "Perfect, that's plenty to start with. Give me one sec and I'll show you around the rest of my home…",
];

interface PrototypeChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** Mirrors the transcript's user text bubble (`transcript-message-body.tsx`). */
const USER_BUBBLE_CLASS =
  "flex max-w-[80%] flex-col gap-2 rounded-lg bg-[var(--user-bubble-bg,var(--surface-lift))] px-4 py-3 text-[var(--user-bubble-text,var(--content-default))]";

interface PrototypeChatPaneProps {
  assistantId: string | null;
}

/**
 * SPIKE — the in-chat onboarding prototype's conversation surface: an
 * absolutely-positioned cover over the real route content that pretends the
 * post-onboarding kickoff message was just sent. It opens mid-conversation —
 * the assistant streaming its welcome, never the empty state — above the
 * REAL composer (attachments enabled) and the real transcript avatar under
 * the latest assistant message. Sends are answered with canned streamed
 * replies; nothing touches the daemon.
 */
export function PrototypeChatPane({ assistantId }: PrototypeChatPaneProps) {
  const { components, traits, customImageUrl } = useAssistantAvatar(assistantId);
  const [messages, setMessages] = useState<PrototypeChatMessage[]>([]);
  /** The in-flight assistant text; null when nothing is streaming. */
  const [streamText, setStreamText] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const streamTimerRef = useRef<number | null>(null);
  const replyTimerRef = useRef<number | null>(null);
  const streamTargetRef = useRef("");
  const replyCountRef = useRef(0);

  const isStreaming = streamText !== null;

  /** Commit the in-flight text as a message and clear the stream. */
  const finishStream = useCallback(() => {
    if (streamTimerRef.current !== null) {
      clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    const full = streamTargetRef.current;
    streamTargetRef.current = "";
    setStreamText(null);
    if (full) {
      setMessages((prev) => [
        ...prev,
        { id: `assistant-${prev.length}`, role: "assistant", text: full },
      ]);
    }
  }, []);

  const streamIn = useCallback(
    (full: string) => {
      streamTargetRef.current = full;
      setStreamText("");
      let shown = 0;
      streamTimerRef.current = window.setInterval(() => {
        shown += STREAM_CHUNK_CHARS;
        if (shown >= full.length) {
          finishStream();
        } else {
          setStreamText(full.slice(0, shown));
        }
      }, STREAM_TICK_MS);
    },
    [finishStream],
  );

  // Kickoff: the conversation opens with the assistant already responding.
  useEffect(() => {
    replyTimerRef.current = window.setTimeout(
      () => streamIn(KICKOFF_MESSAGE),
      KICKOFF_DELAY_MS,
    );
    return () => {
      if (replyTimerRef.current !== null) {
        clearTimeout(replyTimerRef.current);
      }
      if (streamTimerRef.current !== null) {
        clearInterval(streamTimerRef.current);
      }
    };
  }, [streamIn]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages, streamText]);

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const store = useComposerStore.getState();
      const text = store.input.trim();
      if (!text || isStreaming) {
        return;
      }
      setMessages((prev) => [
        ...prev,
        { id: `user-${prev.length}`, role: "user", text },
      ]);
      store.setInput("");
      store.resetAttachments();
      const reply =
        CANNED_REPLIES[Math.min(replyCountRef.current, CANNED_REPLIES.length - 1)];
      replyCountRef.current += 1;
      replyTimerRef.current = window.setTimeout(
        () => streamIn(reply),
        REPLY_DELAY_MS,
      );
    },
    [isStreaming, streamIn],
  );

  const handleAddAttachmentFiles = useCallback(
    (files: FileList | File[]) => {
      useComposerStore.getState().addFiles(files, assistantId);
    },
    [assistantId],
  );

  const showAvatar =
    isStreaming || messages.some((m) => m.role === "assistant");

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col"
      style={{ background: "var(--surface-base)" }}
    >
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[var(--chat-max-width)] flex-col gap-4 px-4 pt-6 pb-4 sm:px-6">
          {messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="flex justify-end">
                <div className={USER_BUBBLE_CLASS}>{message.text}</div>
              </div>
            ) : (
              <div key={message.id} className="flex justify-start">
                <div className="w-full min-w-0">
                  <ChatMarkdownMessage content={message.text} />
                </div>
              </div>
            ),
          )}
          {streamText !== null ? (
            <div className="flex justify-start">
              <div className="w-full min-w-0">
                <ChatMarkdownMessage content={streamText} />
              </div>
            </div>
          ) : null}
          {showAvatar ? (
            <div
              data-latest-assistant-avatar="true"
              className="flex justify-start pt-1 pb-2 pl-1"
            >
              <ChatAvatar
                components={components}
                traits={traits}
                customImageUrl={customImageUrl}
                isAssistantBusy={isStreaming}
              />
            </div>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 px-4 pb-4 sm:px-6">
        <div className="mx-auto w-full max-w-[var(--chat-max-width)]">
          <ChatComposer
            onSubmit={handleSubmit}
            inputRef={inputRef}
            typingDisabled={false}
            sendDisabled={isStreaming}
            onAddAttachmentFiles={handleAddAttachmentFiles}
            onStopGenerating={finishStream}
            isAssistantBusy={isStreaming}
            assistantId={assistantId}
          />
        </div>
      </div>
    </div>
  );
}
