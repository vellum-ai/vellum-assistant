import { beforeEach, expect, mock, test } from "bun:test";

import type { ConversationPendingInteractions } from "@/domains/chat/api/interactions";

const fetchPending = mock<() => Promise<ConversationPendingInteractions>>(
  async () => ({}),
);
mock.module("@/domains/chat/api/interactions", () => ({
  getPendingInteractions: fetchPending,
}));

const { reconcileDesktopHelp } = await import("./reconcile-desktop-help");
const { useDesktopPreviewStore } = await import("./desktop-preview-store");

beforeEach(() => {
  fetchPending.mockReset();
  fetchPending.mockResolvedValue({});
  useDesktopPreviewStore.setState({ submittedHelpRequests: {}, session: null });
  useDesktopPreviewStore
    .getState()
    .markHelpSubmitted("asst-1", "req-help", "conv-help");
  useDesktopPreviewStore.getState().openFullscreen("asst-1");
});

test("confirmed absence clears the missed resolution and returns to preview", async () => {
  fetchPending.mockResolvedValue({ pendingQuestion: null });
  await reconcileDesktopHelp("asst-1");
  expect(fetchPending).toHaveBeenCalledWith("asst-1", "conv-help");
  expect(useDesktopPreviewStore.getState().submittedHelpRequests).toEqual({});
  expect(useDesktopPreviewStore.getState().session?.view).toBe("preview");
});

const unconfirmedQuestions: ConversationPendingInteractions["pendingQuestion"][] =
  [undefined, { requestId: "req-help", entries: [] }];

test.each(unconfirmedQuestions)(
  "keeps input locked when resolution is unconfirmed: %j",
  async (pendingQuestion) => {
    fetchPending.mockResolvedValue({ pendingQuestion });
    await reconcileDesktopHelp("asst-1");
    expect(
      useDesktopPreviewStore.getState().submittedHelpRequests["asst-1"]
        ?.requestId,
    ).toBe("req-help");
  },
);

test("a newer pending question confirms the submitted request is gone", async () => {
  fetchPending.mockResolvedValue({
    pendingQuestion: { requestId: "req-new", entries: [] },
  });
  await reconcileDesktopHelp("asst-1");
  expect(useDesktopPreviewStore.getState().submittedHelpRequests).toEqual({});
});

test("a failed recovery fetch keeps input locked", async () => {
  fetchPending.mockRejectedValue(new Error("Connection lost"));
  await reconcileDesktopHelp("asst-1");
  expect(
    useDesktopPreviewStore.getState().submittedHelpRequests["asst-1"]
      ?.requestId,
  ).toBe("req-help");
});

test("a late recovery cannot unlock a newer submission", async () => {
  let resolve!: (value: ConversationPendingInteractions) => void;
  fetchPending.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const recovery = reconcileDesktopHelp("asst-1");
  useDesktopPreviewStore
    .getState()
    .markHelpSubmitted("asst-1", "req-new", "conv-new");
  resolve({ pendingQuestion: null });
  await recovery;
  expect(
    useDesktopPreviewStore.getState().submittedHelpRequests["asst-1"]
      ?.requestId,
  ).toBe("req-new");
  expect(useDesktopPreviewStore.getState().session?.view).toBe("fullscreen");
});
