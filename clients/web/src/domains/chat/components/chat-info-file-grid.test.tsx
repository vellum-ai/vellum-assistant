/**
 * `ChatInfoFileGrid`: the panel's second level, given one file category's
 * items.
 *
 * The real tiles render here, since what the grid owns is the set of them and
 * the paging control under it. Bytes are never fetched: the frames carry their
 * preview inline and the query client serves only what a test seeds. How a
 * tile labels itself is the tile suite's.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  makeDisplayAttachment,
  SAMPLE_PREVIEWS,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { ChatInfoFileGrid } from "@/domains/chat/components/chat-info-file-grid";
import {
  installChatInfoDomStubs,
  makeChatInfoQueryClient,
  makeFileAsset,
  makeFrameAsset,
} from "@/domains/chat/components/chat-info.test-helper";
import type { ConversationFileAsset } from "@/domains/chat/hooks/use-conversation-assets";

const restoreDomStubs = installChatInfoDomStubs();

const ASSISTANT_ID = "asst-1";

const FRAME = makeFrameAsset(
  makeDisplayAttachment({
    id: "frame-1",
    filename: "frame-01.jpg",
    mimeType: "image/jpeg",
    previewUrl: SAMPLE_PREVIEWS[1]!,
  }),
  new Date(2001, 4, 27, 10, 30).getTime(),
);

const FILE = makeFileAsset(
  makeDisplayAttachment({
    id: "att-1",
    filename: "itinerary.pdf",
    mimeType: "application/pdf",
  }),
);

function renderGrid({
  items = [FRAME],
  hasMore = false,
  onLoadMore = () => {},
  onOpen = () => {},
}: {
  items?: ConversationFileAsset[];
  hasMore?: boolean;
  onLoadMore?: () => void;
  onOpen?: (file: ConversationFileAsset) => void;
} = {}): void {
  render(
    <QueryClientProvider client={makeChatInfoQueryClient()}>
      <ChatInfoFileGrid
        items={items}
        assistantId={ASSISTANT_ID}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
        onOpen={onOpen}
      />
    </QueryClientProvider>,
  );
}

function loadMore(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Load more" });
}

afterEach(() => {
  cleanup();
});

// The stubbed browser APIs are put back before the next file loads; the suite
// installs no module mock of its own.
afterAll(() => {
  restoreDomStubs();
});

describe("ChatInfoFileGrid", () => {
  test("gives every item its own tile", () => {
    renderGrid({ items: [FRAME, FILE] });

    expect(screen.getByLabelText("Preview camera frame")).toBeDefined();
    expect(screen.getByLabelText("Preview itinerary.pdf")).toBeDefined();
  });

  test("opens the tile that was activated", () => {
    const opened: string[] = [];
    renderGrid({ items: [FILE], onOpen: (file) => opened.push(file.id) });

    fireEvent.click(screen.getByLabelText("Preview itinerary.pdf"));

    expect(opened).toEqual([FILE.id]);
  });

  test("fetches the next page from the Load more control", () => {
    const onLoadMore = mock(() => {});
    renderGrid({ hasMore: true, onLoadMore });

    expect(loadMore()).not.toBeNull();
    fireEvent.click(loadMore()!);

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  test("offers no Load more for a category that holds everything", () => {
    renderGrid({ hasMore: false });

    expect(loadMore()).toBeNull();
  });
});
