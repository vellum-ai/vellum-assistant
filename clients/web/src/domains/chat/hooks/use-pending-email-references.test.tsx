/**
 * Covers how emails parked by the Assistant Inbox are staged once the draft
 * minted for them is on screen, and dropped when it is not.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

const sentryBreadcrumbMock = mock((_args: unknown) => undefined);
mock.module("@sentry/react", () => ({
  addBreadcrumb: sentryBreadcrumbMock,
  captureException: () => {},
}));

import { consumePendingComposerFocus } from "@/domains/chat/composer-focus";
import {
  selectEmailReferences,
  useComposerStore,
} from "@/domains/chat/composer-store";
import {
  PENDING_COMPOSER_EMAILS_TTL_MS,
  usePendingEmailReferences,
} from "@/domains/chat/hooks/use-pending-email-references";
import {
  __resetPendingDeepLinkForTesting,
  usePendingDeepLinkStore,
} from "@/stores/pending-deep-link-store";
import type { EmailReference } from "@/types/email-reference";

const EMAIL: EmailReference = {
  id: "msg_1",
  direction: "inbound",
  from: { address: "maya@example.com" },
  to: [{ address: "velly@example.org" }],
  subject: "Q4 vendor contract",
  createdAt: "2026-09-16T09:52:00Z",
};

function renderDrain(activeConversationId: string | null) {
  return renderHook(
    (p: { activeConversationId: string | null }) =>
      usePendingEmailReferences(p),
    { initialProps: { activeConversationId } },
  );
}

beforeEach(() => {
  __resetPendingDeepLinkForTesting();
  useComposerStore.getState().resetAttachments();
  consumePendingComposerFocus();
});

afterEach(() => {
  cleanup();
});

describe("usePendingEmailReferences", () => {
  it("stages the parked emails once their draft is the active conversation", () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingComposerEmails({ threadId: "draft-1", emails: [EMAIL] });

    renderDrain("draft-1");

    expect(
      selectEmailReferences(useComposerStore.getState().attachments),
    ).toEqual([EMAIL]);
    expect(usePendingDeepLinkStore.getState().pendingComposerEmails).toBeNull();
    expect(consumePendingComposerFocus()).toBe(true);
  });

  it("waits while no conversation is active, then stages on arrival", () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingComposerEmails({ threadId: "draft-1", emails: [EMAIL] });

    const { rerender } = renderDrain(null);
    expect(useComposerStore.getState().attachments).toHaveLength(0);
    expect(
      usePendingDeepLinkStore.getState().pendingComposerEmails,
    ).not.toBeNull();

    rerender({ activeConversationId: "draft-1" });
    expect(useComposerStore.getState().attachments).toHaveLength(1);
  });

  it("drops the park when the user lands in another conversation", () => {
    usePendingDeepLinkStore
      .getState()
      .setPendingComposerEmails({ threadId: "draft-1", emails: [EMAIL] });

    renderDrain("conv-other");

    expect(useComposerStore.getState().attachments).toHaveLength(0);
    expect(usePendingDeepLinkStore.getState().pendingComposerEmails).toBeNull();
  });

  it("drops a park older than the bound", () => {
    usePendingDeepLinkStore.setState({
      pendingComposerEmails: {
        threadId: "draft-1",
        emails: [EMAIL],
        parkedAt: Date.now() - PENDING_COMPOSER_EMAILS_TTL_MS - 1,
      },
    });

    renderDrain("draft-1");

    expect(useComposerStore.getState().attachments).toHaveLength(0);
    expect(usePendingDeepLinkStore.getState().pendingComposerEmails).toBeNull();
  });

  it("does not stage the same email twice", () => {
    useComposerStore.getState().addEmailReferences([EMAIL]);
    usePendingDeepLinkStore
      .getState()
      .setPendingComposerEmails({ threadId: "draft-1", emails: [EMAIL] });

    renderDrain("draft-1");

    expect(useComposerStore.getState().attachments).toHaveLength(1);
  });
});
