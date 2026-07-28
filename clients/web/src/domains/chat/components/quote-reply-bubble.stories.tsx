import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import { QuoteReplyBubble } from "./quote-reply-bubble";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";

/**
 * The reply-entry modal that opens when the user starts a reply from a text
 * selection: the quoted passage, a reply field, and Cancel / Add to Chat
 * (Rok's "Quote & Reply" polish — node 6485-155641).
 */

/** Seeds the reply bubble into the shared store, then renders it. */
function WithReplyBubble({ quotedText }: { quotedText: string }) {
  useEffect(() => {
    useQuoteReplyStore.setState({
      replyBubble: {
        quotedText,
        sourceMessageId: "msg-1",
        anchorRect: { top: 220, left: 360, width: 0, height: 0 },
      },
    });
    return () => useQuoteReplyStore.setState({ replyBubble: null });
  }, [quotedText]);
  return <QuoteReplyBubble />;
}

const meta: Meta<typeof QuoteReplyBubble> = {
  title: "Chat/QuoteReplyBubble",
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
};

export default meta;
type Story = StoryObj<typeof QuoteReplyBubble>;

export const Default: Story = {
  render: () => <WithReplyBubble quotedText="This is a text that's being quoted" />,
};

export const LongQuote: Story = {
  render: () => (
    <WithReplyBubble quotedText="Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation." />
  ),
};
