/**
 * Tests for `ChannelAvatarDownload`:
 *
 *   1. Saving hands `saveFile` the same raster the preview shows, so what a
 *      user looks at is what lands on disk. Asserted as a pair, because a save
 *      of some other URL would still render a plausible-looking card.
 *   2. The file is offered under a stable name rather than the blob id.
 *   3. The avatar fetched is the assistant passed in, not whichever is
 *      globally active, so a switch mid-setup cannot offer the wrong one.
 *   4. Nothing renders when the workspace has no raster, since a thumbnail
 *      beside a dead control is worse than no suggestion.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";

import type { AvatarFileResult } from "@/assistant/avatar-api";

// Typed against the real result union so a test cannot assert a shape the
// module never returns.
const fetchAvatarImageUrlResult = mock(
  async (_assistantId: string): Promise<AvatarFileResult<string>> => ({
    status: "found",
    value: "blob:avatar-raster",
  }),
);
const saveFile = mock(async (_source: Blob | string, _filename: string) => {});

const actualApi = await import("@/assistant/avatar-api");
mock.module("@/assistant/avatar-api", () => ({
  ...actualApi,
  fetchAvatarImageUrlResult,
}));

const actualNativeFile = await import("@/runtime/native-file");
mock.module("@/runtime/native-file", () => ({
  ...actualNativeFile,
  saveFile,
}));

const { ChannelAvatarDownload } = await import(
  "@/components/channel-avatar-download"
);

/** A fresh cache per test, so one test's raster cannot satisfy the next. */
function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchAvatarImageUrlResult.mockClear();
  saveFile.mockClear();
  fetchAvatarImageUrlResult.mockResolvedValue({
    status: "found",
    value: "blob:avatar-raster",
  });
});

afterEach(cleanup);

describe("ChannelAvatarDownload", () => {
  test("saves the raster it previews", async () => {
    renderWithClient(
      <ChannelAvatarDownload assistantId="asst-1" channel="slack" />,
    );

    const image = await screen.findByRole("img");
    expect(image.getAttribute("src")).toBe("blob:avatar-raster");

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(saveFile).toHaveBeenCalledTimes(1);
    });
    // The same URL the preview rendered, so the two cannot drift apart.
    expect(saveFile.mock.calls[0]![0]).toBe("blob:avatar-raster");
  });

  test("names the saved file rather than leaving the blob id", async () => {
    renderWithClient(
      <ChannelAvatarDownload assistantId="asst-1" channel="discord" />,
    );

    fireEvent.click(await screen.findByRole("button"));

    await waitFor(() => {
      expect(saveFile).toHaveBeenCalledTimes(1);
    });
    expect(saveFile.mock.calls[0]![1]).toBe("assistant-avatar.png");
  });

  test("fetches the assistant it was given, not the active one", async () => {
    renderWithClient(
      <ChannelAvatarDownload assistantId="asst-panel" channel="slack" />,
    );

    await waitFor(() => {
      expect(fetchAvatarImageUrlResult).toHaveBeenCalled();
    });
    expect(fetchAvatarImageUrlResult.mock.calls[0]![0]).toBe("asst-panel");
  });

  test("renders nothing when the workspace has no raster", async () => {
    fetchAvatarImageUrlResult.mockResolvedValue({ status: "absent" });

    const { container } = renderWithClient(
      <ChannelAvatarDownload assistantId="asst-1" channel="telegram" />,
    );

    await waitFor(() => {
      expect(fetchAvatarImageUrlResult).toHaveBeenCalled();
    });
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
