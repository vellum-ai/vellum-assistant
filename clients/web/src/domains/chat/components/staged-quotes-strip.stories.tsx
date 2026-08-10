/**
 * The staged-quotes strip: the quotes the user has pulled from assistant
 * messages, each with an editable reply, rendered above the composer. When a
 * quote is added the strip scrolls to reveal the newest chip.
 *
 * The strip's whole job is to sit between the transcript and the composer, so
 * these stories mount it where `chat-body` mounts it: inside the footer
 * column, with the real `ChatComposer` as its next sibling. Its own `mb-2` is
 * the gap to that composer, and its width comes from the column rather than
 * from itself, so neither is reviewable with the strip standing alone.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef } from "react";
import { Button } from "@vellumai/design-library";

import { StagedQuotesStrip } from "./staged-quotes-strip";
import { ChatComposer } from "@/domains/chat/components/chat-composer/chat-composer";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";

const SAMPLE_QUOTES = [
  {
    quotedText: "the river model of memory",
    replyText: "Expand on this a lot more, please.",
  },
  {
    quotedText: "finding the path of least resistance",
    replyText: "What does this mean concretely?",
  },
  {
    quotedText: "an eddy that thinks it's the river",
    replyText: "Is this a metaphor for identity?",
  },
  {
    quotedText: "your memories are a record or just a current",
    replyText: "Which one do you believe?",
  },
];

/** Stages the next sample quote, cycling once the samples run out. */
function stageAnotherQuote() {
  const n = useQuoteReplyStore.getState().stagedQuotes.length;
  const quote = SAMPLE_QUOTES[n % SAMPLE_QUOTES.length]!;
  useQuoteReplyStore
    .getState()
    .addStagedQuote({ ...quote, sourceMessageId: `msg-${n}` });
}

/** Seeds the store with `count` staged quotes, then renders the real strip. */
function SeededStrip({ count }: { count: number }) {
  useEffect(() => {
    useQuoteReplyStore.setState({ stagedQuotes: [] });
    for (const quote of SAMPLE_QUOTES.slice(0, count)) {
      useQuoteReplyStore
        .getState()
        .addStagedQuote({ ...quote, sourceMessageId: "msg-1" });
    }
    return () => useQuoteReplyStore.setState({ stagedQuotes: [] });
  }, [count]);

  return <StagedQuotesStrip />;
}

/**
 * The composer the strip actually sits on. Every required prop is an input the
 * orchestrator hands down, so the real component mounts on story-supplied
 * callbacks; nothing here stands in for a value the app derives.
 */
function StoryComposer() {
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

const meta: Meta<typeof StagedQuotesStrip> = {
  title: "Chat/StagedQuotesStrip",
  parameters: { layout: "fullscreen", controls: { disable: true } },
  decorators: [
    /* `chat-body`'s footer column, class for class: the bottom-anchored body,
       the `px-3 pt-1 pb-2 sm:px-6 sm:pb-0` wrapper, and the
       `mx-auto max-w-[var(--chat-max-width)]` child the strip shares with the
       composer. Keep in sync with `chat-body.tsx`. */
    (Story) => (
      <div className="flex h-screen flex-col justify-end">
        <div className="px-3 pt-1 pb-2 sm:px-6 sm:pb-0">
          <div className="mx-auto max-w-[var(--chat-max-width)]">
            <Story />
            <StoryComposer />
          </div>
        </div>
        {/* Harness control, deliberately outside the mirrored app column. */}
        <div className="px-3 py-3 sm:px-6">
          <Button variant="outlined" size="compact" onClick={stageAnotherQuote}>
            Stage another quote
          </Button>
        </div>
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof StagedQuotesStrip>;

/** A few staged quotes; click "Stage another" to confirm it scrolls to the newest. */
export const Overflowing: Story = {
  render: () => <SeededStrip count={3} />,
};

/** Single staged quote with an editable reply. */
export const Single: Story = {
  render: () => <SeededStrip count={1} />,
};

/** Starts empty; click "Stage another" to confirm the very first chip animates in. */
export const Empty: Story = {
  render: () => <SeededStrip count={0} />,
};
