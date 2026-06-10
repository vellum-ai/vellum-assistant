import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

// The transcript transitively pulls in the viewer store → the generated daemon
// SDK (not built in CI/worktree checkouts). Stub the two endpoints it
// references so the module loads; nothing here invokes them.
mock.module("@/generated/daemon/sdk.gen", () => ({
  appsByIdOpenPost: async () => ({ data: undefined }),
  documentsByIdGet: async () => ({ data: undefined }),
}));

// Stub both render trees and the sibling row components to lightweight markers
// so the routing assertions don't depend on any body internals.
mock.module("@/domains/chat/transcript/transcript-message-body", () => ({
  TranscriptMessageBody: () => <div data-testid="positional-body" />,
}));
mock.module("@/domains/chat/transcript/transcript-message-content", () => ({
  TranscriptMessageContent: () => <div data-testid="blocks-body" />,
}));
mock.module("@/domains/chat/components/surfaces/surface-router", () => ({
  SurfaceRouter: () => <div data-testid="surface" />,
}));
mock.module("@/domains/chat/transcript/pending-confirmation-row", () => ({
  PendingConfirmationRow: () => null,
}));
mock.module("@/domains/chat/transcript/pending-contact-request-row", () => ({
  PendingContactRequestRow: () => null,
}));
mock.module("@/domains/chat/transcript/pending-secret-row", () => ({
  PendingSecretRow: () => null,
}));

// Drive the single render seam from a mutable flag so each case can flip it
// without touching localStorage. Defaults off, matching production.
let renderFromContentBlocksFlag = false;
mock.module("@/lib/backwards-compat/content-blocks-render-flag", () => ({
  getRenderFromContentBlocks: () => renderFromContentBlocksFlag,
}));

import type { MessageItem } from "@/domains/chat/transcript/types";

import { TranscriptRow } from "@/domains/chat/transcript/transcript-row";

const noop = () => {};

const messageItem: MessageItem = {
  key: "m1",
  kind: "message",
  message: { id: "m1", role: "assistant", timestamp: 1_000 },
};

afterAll(() => {
  mock.restore();
});
afterEach(() => {
  cleanup();
  renderFromContentBlocksFlag = false;
});

describe("TranscriptRow render seam", () => {
  test("routes a message to the positional body when the flag is off", () => {
    // GIVEN the renderFromContentBlocks flag is off (production default)
    renderFromContentBlocksFlag = false;

    // WHEN a message row renders
    const { queryByTestId } = render(
      <TranscriptRow item={messageItem} onSurfaceAction={noop} />,
    );

    // THEN the positional `TranscriptMessageBody` tree renders, not the blocks one
    expect(queryByTestId("positional-body")).not.toBeNull();
    expect(queryByTestId("blocks-body")).toBeNull();
  });

  test("routes a message to the blocks body when the flag is on", () => {
    // GIVEN the renderFromContentBlocks flag is on
    renderFromContentBlocksFlag = true;

    // WHEN a message row renders
    const { queryByTestId } = render(
      <TranscriptRow item={messageItem} onSurfaceAction={noop} />,
    );

    // THEN the blocks-driven `TranscriptMessageContent` tree renders instead
    expect(queryByTestId("blocks-body")).not.toBeNull();
    expect(queryByTestId("positional-body")).toBeNull();
  });
});
