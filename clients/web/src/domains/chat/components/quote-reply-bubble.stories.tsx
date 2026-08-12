/**
 * The reply-entry surface that opens when the user starts a reply from a text
 * selection: the quoted passage, a reply field, and Cancel / Add to Chat
 * (Rok's "Quote & Reply" polish, node 6485-155641).
 *
 * The bubble renders one of two different things, and both are positioned
 * against something outside themselves, so neither is reviewable with the
 * bubble standing alone:
 *
 * - **Desktop**: a popover anchored to the selection rect in the transcript.
 * - **Touch-mobile**: a portal docked full width above the composer, placed by
 *   measuring `[data-slot="chat-composer"]` out of the document.
 *
 * So these stories mount it where `chat-route-content` mounts it: as a sibling
 * of the chat body, with the real footer stack (`ChatColumn` on the real
 * `ChatComposer`) present in the page. Without that composer the dock has
 * nothing to measure, falls back to the viewport bottom, and looks the same
 * whether its measurement works or not.
 *
 * Reaching the touch branch needs a coarse pointer as well as a narrow
 * viewport, which the Storybook viewport toolbar does not emulate; device
 * emulation in a browser does. Tracked in LUM-3179.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import { QuoteReplyBubble } from "./quote-reply-bubble";
import { ChatFooterShell } from "@/domains/chat/components/chat-footer-fixtures";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";

/**
 * Where in the viewport the quoted passage was selected. The app measures this
 * off the selection range (`text-selection-popover.tsx:169-176`); a story has
 * no selection, so this stands in for it, and it is the one value here that
 * does. It only drives the desktop popover: the touch dock ignores the anchor
 * and measures the composer instead.
 */
const SELECTION_ANCHOR = { top: 220, left: 360, width: 0, height: 0 };

interface QuoteReplyStoryArgs {
  /** The passage the user selected, as `openReplyBubble` receives it. */
  quotedText: string;
}

/** Opens the bubble through the store's own write path, then renders it. */
function OpenedBubble({ quotedText }: QuoteReplyStoryArgs) {
  useEffect(() => {
    useQuoteReplyStore.getState().openReplyBubble({
      quotedText,
      sourceMessageId: "msg-1",
      anchorRect: SELECTION_ANCHOR,
    });
    return () => useQuoteReplyStore.getState().closeReplyBubble();
  }, [quotedText]);

  return <QuoteReplyBubble />;
}

const meta: Meta<QuoteReplyStoryArgs> = {
  title: "Chat/QuoteReplyBubble",
  parameters: { layout: "fullscreen" },
  decorators: [
    /* The bubble is a sibling of the chat body in `chat-route-content.tsx`, not
       a child of the footer column, so it sits beside the shell rather than
       inside it. The shell is what puts a real composer in the document for
       the touch dock to measure. */
    (Story) => (
      <>
        <ChatFooterShell />
        <Story />
      </>
    ),
  ],
  args: {
    quotedText: "This is a text that's being quoted",
  },
  render: (args) => <OpenedBubble {...args} />,
};

export default meta;
type Story = StoryObj<QuoteReplyStoryArgs>;

/** A short passage: the card sizes to its fixed 360px popover width. */
export const Default: Story = {};

/** Past 200 characters the quote is truncated with an ellipsis. */
export const LongQuote: Story = {
  args: {
    quotedText:
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation.",
  },
};

/**
 * A narrow window with a fine pointer, which is a shrunk desktop window rather
 * than a phone. The popover keeps its 12px collision padding here instead of
 * docking: the dock needs `pointer: coarse` too, and the viewport toolbar sets
 * width only. Use browser device emulation to see the docked treatment.
 */
export const NarrowWindow: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
