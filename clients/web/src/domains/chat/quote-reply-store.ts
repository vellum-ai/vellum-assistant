/**
 * quote-reply-store — Zustand store for the quote-and-reply feature.
 *
 * Owns:
 * - Staged quotes (quoted text + user reply, pending inclusion in the next send)
 * - Reply bubble state (open/closed, position, quoted text being replied to)
 *
 * The store is consumed by:
 * - `TextSelectionPopover` (opens a reply bubble from the current selection)
 * - `QuoteReplyBubble` (reads replyBubble state, writes via addToChat / dismiss)
 * - `StagedQuotesStrip` (reads stagedQuotes, removes individual quotes)
 * - `useSendMessage` / composer integration (reads + clears stagedQuotes on send)
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

export interface StagedQuote {
  id: string;
  quotedText: string;
  replyText: string;
  sourceMessageId: string;
}

export interface ReplyBubbleState {
  quotedText: string;
  sourceMessageId: string;
  /** Anchor position for the bubble, relative to the viewport. */
  anchorRect: { top: number; left: number; width: number; height: number };
}

interface QuoteReplyState {
  stagedQuotes: StagedQuote[];
  replyBubble: ReplyBubbleState | null;
}

interface QuoteReplyActions {
  openReplyBubble: (params: {
    quotedText: string;
    sourceMessageId: string;
    anchorRect: { top: number; left: number; width: number; height: number };
  }) => void;
  closeReplyBubble: () => void;
  addStagedQuote: (quote: Omit<StagedQuote, "id">) => void;
  removeStagedQuote: (id: string) => void;
  clearStagedQuotes: () => void;
}

type QuoteReplyStore = QuoteReplyState & QuoteReplyActions;

function createQuoteId(): string {
  return `quote-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const useQuoteReplyStoreBase = create<QuoteReplyStore>()((set) => ({
  stagedQuotes: [],
  replyBubble: null,

  openReplyBubble: ({ quotedText, sourceMessageId, anchorRect }) =>
    set({
      replyBubble: { quotedText, sourceMessageId, anchorRect },
    }),

  closeReplyBubble: () => set({ replyBubble: null }),

  addStagedQuote: (quote) =>
    set((s) => ({
      stagedQuotes: [
        ...s.stagedQuotes,
        { ...quote, id: createQuoteId() },
      ],
      replyBubble: null,
    })),

  removeStagedQuote: (id) =>
    set((s) => ({
      stagedQuotes: s.stagedQuotes.filter((q) => q.id !== id),
    })),

  clearStagedQuotes: () => set({ stagedQuotes: [] }),
}));

export const useQuoteReplyStore = createSelectors(useQuoteReplyStoreBase);
