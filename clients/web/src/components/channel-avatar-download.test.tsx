/**
 * Tests for `ChannelAvatarDownload`:
 *
 *   1. The download link points at the same raster the preview shows, so what
 *      a user looks at is what lands on disk.
 *   2. The file is offered under a stable name rather than the blob id.
 *   3. Nothing renders when the workspace has no avatar raster, since a
 *      thumbnail beside a dead link is worse than no suggestion.
 *   4. Nothing renders before an assistant is selected, which is the state the
 *      wizard mounts in.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import type { AvatarFileResult } from "@/assistant/avatar-api";

// Typed against the real result union so a test cannot assert a shape the
// module never returns.
const fetchAvatarImageUrlResult = mock(
  async (): Promise<AvatarFileResult<string>> => ({
    status: "found",
    value: "blob:avatar-raster",
  }),
);
let activeAssistantId: string | null = "asst-1";

const actualApi = await import("@/assistant/avatar-api");
mock.module("@/assistant/avatar-api", () => ({
  ...actualApi,
  fetchAvatarImageUrlResult,
}));

const actualStore = await import("@/stores/resolved-assistants-store");
mock.module("@/stores/resolved-assistants-store", () => ({
  ...actualStore,
  useResolvedAssistantsStore: {
    ...actualStore.useResolvedAssistantsStore,
    use: { activeAssistantId: () => activeAssistantId },
  },
}));

const { ChannelAvatarDownload } = await import(
  "@/components/channel-avatar-download"
);

beforeEach(() => {
  activeAssistantId = "asst-1";
  fetchAvatarImageUrlResult.mockClear();
  fetchAvatarImageUrlResult.mockResolvedValue({
    status: "found",
    value: "blob:avatar-raster",
  });
});

afterEach(cleanup);

describe("ChannelAvatarDownload", () => {
  test("offers the raster it previews", async () => {
    render(<ChannelAvatarDownload channel="slack" />);

    const image = await screen.findByRole("img");
    expect(image.getAttribute("src")).toBe("blob:avatar-raster");

    const link = screen.getByRole("link");
    // Asserted as a pair: a link pointing somewhere other than the preview
    // would still render a plausible-looking card.
    expect(link.getAttribute("href")).toBe("blob:avatar-raster");
  });

  test("names the downloaded file rather than leaving the blob id", async () => {
    render(<ChannelAvatarDownload channel="discord" />);

    const link = await screen.findByRole("link");
    expect(link.getAttribute("download")).toBe("assistant-avatar.png");
  });

  test("renders nothing when the workspace has no raster", async () => {
    fetchAvatarImageUrlResult.mockResolvedValue({ status: "absent" });

    const { container } = render(<ChannelAvatarDownload channel="telegram" />);

    await waitFor(() => {
      expect(fetchAvatarImageUrlResult).toHaveBeenCalled();
    });
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("renders nothing before an assistant is selected", () => {
    activeAssistantId = null;

    const { container } = render(<ChannelAvatarDownload channel="slack" />);

    expect(container.textContent).toBe("");
    expect(fetchAvatarImageUrlResult).not.toHaveBeenCalled();
  });
});
