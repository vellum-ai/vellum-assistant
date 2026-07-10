import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { Button } from "@vellumai/design-library";

import { StagedQuotesStrip } from "./staged-quotes-strip";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";

/**
 * The staged-quotes strip: the quotes the user has pulled from assistant
 * messages, each with an editable reply, rendered above the composer. When a
 * quote is added the strip scrolls to reveal the newest chip.
 */

const SAMPLE_QUOTES = [
  { quotedText: "the river model of memory", replyText: "Expand on this a lot more, please." },
  { quotedText: "finding the path of least resistance", replyText: "What does this mean concretely?" },
  { quotedText: "an eddy that thinks it's the river", replyText: "Is this a metaphor for identity?" },
  { quotedText: "your memories are a record or just a current", replyText: "Which one do you believe?" },
];

/** Renders the strip plus a button that stages another quote (to test scroll). */
function StripHarness({ initialCount }: { initialCount: number }) {
  useEffect(() => {
    useQuoteReplyStore.setState({ stagedQuotes: [] });
    for (const q of SAMPLE_QUOTES.slice(0, initialCount)) {
      useQuoteReplyStore.getState().addStagedQuote({ ...q, sourceMessageId: "msg-1" });
    }
    return () => useQuoteReplyStore.setState({ stagedQuotes: [] });
  }, [initialCount]);

  const stageAnother = () => {
    const n = useQuoteReplyStore.getState().stagedQuotes.length;
    const q = SAMPLE_QUOTES[n % SAMPLE_QUOTES.length]!;
    useQuoteReplyStore
      .getState()
      .addStagedQuote({ ...q, sourceMessageId: `msg-${n}` });
  };

  return (
    <div className="mx-auto max-w-[720px]">
      <div className="rounded-[10px] bg-[var(--surface-base)] p-2">
        <StagedQuotesStrip />
        <div className="px-4 pt-3 pb-2 text-chat text-[var(--content-disabled)]">
          What would you like to do?
        </div>
      </div>
      <div className="mt-3">
        <Button variant="outlined" size="compact" onClick={stageAnother}>
          Stage another quote
        </Button>
      </div>
    </div>
  );
}

const meta: Meta<typeof StagedQuotesStrip> = {
  title: "Chat/StagedQuotesStrip",
  parameters: { layout: "padded", controls: { disable: true } },
};

export default meta;
type Story = StoryObj<typeof StagedQuotesStrip>;

/** A few staged quotes; click "Stage another" to confirm it scrolls to the newest. */
export const Overflowing: Story = {
  render: () => <StripHarness initialCount={3} />,
};

/** Single staged quote with an editable reply. */
export const Single: Story = {
  render: () => <StripHarness initialCount={1} />,
};

/** Starts empty; click "Stage another" to confirm the very first chip animates in. */
export const Empty: Story = {
  render: () => <StripHarness initialCount={0} />,
};
