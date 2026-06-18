/**
 * quote-reply-store — Zustand store for the quote-and-reply feature.
 *
 * Owns:
 * - Staged quotes (quoted text + user reply, pending inclusion in the next send)
 * - Active selection state (the text currently highlighted for quoting)
 * - Reply bubble state (open/closed, position, quoted text being replied to)
 *
 * The store is consumed by:
 * - `TextSelectionPopover` (reads activeSelection, writes via startReply)
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

export interface ActiveSelection {
  text: string;
  sourceMessageId: string;
  /** Bounding rect of the selection, relative to the viewport. */
  rect: { top: number; left: number; width: number; height: number };
}

export interface ReplyBubbleState {
  quotedText: string;
  sourceMessageId: string;
  /** Anchor position for the bubble, relative to the viewport. */
  anchorRect: { top: number; left: number; width: number; height: number };
}

interface QuoteReplyState {
  stagedQuotes: StagedQuote[];
  activeSelection: ActiveSelection | null;
  replyBubble: ReplyBubbleState | null;
}

interface QuoteReplyActions {
  setActiveSelection: (selection: ActiveSelection | null) => void;
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
  activeSelection: null,
  replyBubble: null,

  setActiveSelection: (selection) => set({ activeSelection: selection }),

  openReplyBubble: ({ quotedText, sourceMessageId, anchorRect }) =>
    set({
      replyBubble: { quotedText, sourceMessageId, anchorRect },
      activeSelection: null,
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
