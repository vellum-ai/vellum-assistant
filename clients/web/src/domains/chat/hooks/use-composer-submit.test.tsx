/**
 * Tests for `useComposerSubmit`, focused on the optional `beforeSend` gate:
 * a blocking gate must cancel the send losslessly (draft, attachments, and
 * staged quotes untouched), while a passing or omitted gate leaves the
 * submit path unchanged. Uses the real composer and quote-reply stores,
 * reset between tests. The token below is a synthetic value invented for
 * these tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  useComposerStore,
  type UploadedAttachment,
} from "@/domains/chat/composer-store";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import type { DisplayAttachment } from "@/domains/chat/types/types";

import {
  useComposerSubmit,
  type UseComposerSubmitParams,
} from "./use-composer-submit";

const SYNTHETIC_PROJECT_KEY =
  "sk-proj-Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3A";

const uploadedAttachment: UploadedAttachment = {
  kind: "uploaded",
  localId: "local-1",
  id: "attachment-1",
  filename: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 12,
  previewUrl: null,
  thumbnailUrl: null,
};

function renderSubmit(overrides: Partial<UseComposerSubmitParams> = {}) {
  const sendMessage = mock(
    async (
      _content: string,
      _attachments?: DisplayAttachment[],
      _opts?: { bypassSecretCheck?: boolean },
    ) => {},
  );
  const { result } = renderHook(() =>
    useComposerSubmit({
      sendMessage,
      inputRef: { current: null },
      scrollToLatest: () => {},
      isEditing: false,
      editingMessageId: null,
      cancelEditing: () => {},
      canUndoEdit: false,
      sendDisabled: false,
      typingDisabled: false,
      assistantId: "assistant-1",
      activeConversationId: "conv-1",
      ...overrides,
    }),
  );
  return { result, sendMessage };
}

async function submit(result: {
  current: { submitMessage: (inputOverride?: string) => Promise<void> };
}) {
  await act(async () => {
    await result.current.submitMessage();
  });
}

beforeEach(() => {
  useComposerStore.getState().setInput("");
  useComposerStore.getState().resetAttachments();
  useQuoteReplyStore.getState().clearStagedQuotes();
});

afterEach(() => {
  cleanup();
});

describe("useComposerSubmit beforeSend gate", () => {
  test("blocking gate cancels the send with draft, attachments, and quotes intact", async () => {
    const draft = `deploy with ${SYNTHETIC_PROJECT_KEY}`;
    useComposerStore.getState().setInput(draft);
    useComposerStore.setState({ attachments: [uploadedAttachment] });
    useQuoteReplyStore.getState().addStagedQuote({
      quotedText: "which key?",
      replyText: "this one",
      sourceMessageId: "msg-1",
    });

    const beforeSend = mock((_content: string) => false);
    const { result, sendMessage } = renderSubmit({ beforeSend });
    await submit(result);

    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    // Nothing was cleared by the interception.
    expect(useComposerStore.getState().input).toBe(draft);
    expect(useComposerStore.getState().attachments).toEqual([
      uploadedAttachment,
    ]);
    expect(useQuoteReplyStore.getState().stagedQuotes).toHaveLength(1);
  });

  test("gate sees the assembled outgoing content, not just the raw draft", async () => {
    useComposerStore.getState().setInput("freeform text");
    useQuoteReplyStore.getState().addStagedQuote({
      quotedText: `quoted ${SYNTHETIC_PROJECT_KEY}`,
      replyText: "about this",
      sourceMessageId: "msg-1",
    });

    const beforeSend = mock((_content: string) => false);
    const { result } = renderSubmit({ beforeSend });
    await submit(result);

    const seen = beforeSend.mock.calls[0]?.[0];
    expect(seen).toContain(`> quoted ${SYNTHETIC_PROJECT_KEY}`);
    expect(seen).toContain("freeform text");
  });

  test("passing gate sends the same assembled content and clears the draft", async () => {
    useComposerStore.getState().setInput("all clear");
    const beforeSend = mock((_content: string) => true);
    const { result, sendMessage } = renderSubmit({ beforeSend });
    await submit(result);

    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe("all clear");
    expect(beforeSend.mock.calls[0]?.[0]).toBe("all clear");
    expect(useComposerStore.getState().input).toBe("");
  });

  test("omitted gate leaves the submit path unchanged", async () => {
    useComposerStore.getState().setInput("no gate here");
    const { result, sendMessage } = renderSubmit();
    await submit(result);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe("no gate here");
    expect(useComposerStore.getState().input).toBe("");
  });

  test("empty submits return before the gate is consulted", async () => {
    const beforeSend = mock((_content: string) => false);
    const { result, sendMessage } = renderSubmit({ beforeSend });
    await submit(result);

    expect(beforeSend).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("useComposerSubmit bypassSecretCheck plumbing", () => {
  test("Send-anyway submits forward bypassSecretCheck to sendMessage for that send only", async () => {
    useComposerStore.getState().setInput(`approved ${SYNTHETIC_PROJECT_KEY}`);
    // The gate passes (the detection hook consumed its content-bound
    // allowOnce bypass); the explicit override must ride the send.
    const beforeSend = mock((_content: string) => true);
    const { result, sendMessage } = renderSubmit({ beforeSend });
    await act(async () => {
      await result.current.submitMessage(undefined, {
        bypassSecretCheck: true,
      });
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2]).toEqual({ bypassSecretCheck: true });

    // The very next ordinary submit carries no override.
    useComposerStore.getState().setInput("plain follow-up message");
    await submit(result);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[2]).toBeUndefined();
  });

  test("an ordinary submit never sets bypassSecretCheck", async () => {
    useComposerStore.getState().setInput("no override here");
    const { result, sendMessage } = renderSubmit();
    await submit(result);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2]).toBeUndefined();
  });

  test("a blocking gate keeps the override off the wire entirely", async () => {
    useComposerStore.getState().setInput(`edited to ${SYNTHETIC_PROJECT_KEY}`);
    // The draft changed since the block, so the content-bound bypass
    // missed and the gate re-blocks — the stale Send-anyway click must not
    // send anything, override or not.
    const beforeSend = mock((_content: string) => false);
    const { result, sendMessage } = renderSubmit({ beforeSend });
    await act(async () => {
      await result.current.submitMessage(undefined, {
        bypassSecretCheck: true,
      });
    });

    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
