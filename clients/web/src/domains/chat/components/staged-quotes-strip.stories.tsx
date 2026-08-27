/**
 * The staged-quotes strip: the quotes the user has pulled from assistant
 * messages, each with an editable reply, rendered above the composer. When a
 * quote is added the strip scrolls to reveal the newest chip.
 *
 * The strip's whole job is to sit between the transcript and the composer, so
 * these stories mount it where `chat-body` mounts it: inside the real
 * `ChatColumn`, with the real `ChatComposer` as its next sibling. Its own
 * `mb-2` is the gap to that composer, and its width comes from the column
 * rather than from itself, so neither is reviewable with the strip standing
 * alone.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { Button } from "@vellumai/design-library";

import { StagedQuotesStrip } from "./staged-quotes-strip";
import { ChatColumn } from "@/domains/chat/components/chat-column";
import { StoryComposer } from "@/domains/chat/components/story-composer";
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

const meta: Meta<typeof StagedQuotesStrip> = {
  title: "Chat/StagedQuotesStrip",
  parameters: { layout: "fullscreen", controls: { disable: true } },
  decorators: [
    /* The real `ChatColumn` with the composer stack's own vertical padding,
       inside a bottom-anchored body: the same arrangement `chat-body` builds
       around the strip. Imported rather than mirrored, so a change to the
       column reaches this story on its own. */
    (Story) => (
      <div className="flex h-screen flex-col justify-end">
        <ChatColumn className="pt-1 pb-2 sm:pb-0">
          <Story />
          <StoryComposer placeholder="What would you like to do?" />
        </ChatColumn>
        {/* Harness control, deliberately outside the app column. */}
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
