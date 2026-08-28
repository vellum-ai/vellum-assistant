/**
 * Tests for `useComposerSubmit`: the optional `beforeSend` gate (a blocking
 * gate must cancel the send losslessly, with draft, attachments, staged
 * quotes, and the staged channel reference untouched, while a passing or
 * omitted gate leaves the submit path unchanged) and the staged channel
 * reference's send behavior (sendable alone, leads mixed content, clears on
 * send). Uses the real composer, quote-reply, and channel-reference stores,
 * reset between tests. The token below is a synthetic value invented for
 * these tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { ChannelReference } from "@/domains/chat/channel-sidecar/channel-reference";
import { useChannelReferenceStore } from "@/domains/chat/channel-sidecar/channel-reference-store";
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

/**
 * The Eyes frame upload, replaced so the one question asked of it here is a
 * call count rather than a camera and a network round trip. The real helper
 * answers null with the camera off, which is what every other test in this file
 * would see from it.
 */
const uploadSightFrameAttachment = mock(
  async (_assistantId: string | null): Promise<DisplayAttachment | null> =>
    null,
);
mock.module("@/domains/chat/sight/sight-attachment", () => ({
  uploadSightFrameAttachment,
}));

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

const stagedChannelReference: ChannelReference = {
  messageId: "msg-ext-1",
  conversationId: "conv-1",
  channelId: "slack",
  channelLabel: "Slack",
  senderName: "Alice",
  snippet: "deploy went red on the last step",
  isTruncated: false,
};

beforeEach(() => {
  useComposerStore.getState().setInput("");
  useComposerStore.getState().resetAttachments();
  useQuoteReplyStore.getState().clearStagedQuotes();
  useChannelReferenceStore.setState({ reference: null });
  uploadSightFrameAttachment.mockClear();
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

describe("useComposerSubmit staged channel reference", () => {
  test("a staged reference alone is sendable, leads the content, and clears on send", async () => {
    useChannelReferenceStore.getState().setReference(stagedChannelReference);

    const { result, sendMessage } = renderSubmit();
    await submit(result);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0]?.[0];
    expect(sent?.startsWith("> [vellum:channel-reference]")).toBe(true);
    expect(sent).toContain("deploy went red on the last step");
    expect(useChannelReferenceStore.getState().reference).toBeNull();
  });

  test("reference plus typed text sends the reference block first, then the remark", async () => {
    useChannelReferenceStore.getState().setReference(stagedChannelReference);
    useComposerStore.getState().setInput("what broke here?");

    const { result, sendMessage } = renderSubmit();
    await submit(result);

    const sent = sendMessage.mock.calls[0]?.[0];
    expect(sent?.startsWith("> [vellum:channel-reference]")).toBe(true);
    expect(sent?.endsWith("what broke here?")).toBe(true);
    expect(useChannelReferenceStore.getState().reference).toBeNull();
    expect(useComposerStore.getState().input).toBe("");
  });

  test("a blocking gate leaves the staged reference intact", async () => {
    useChannelReferenceStore.getState().setReference(stagedChannelReference);

    const beforeSend = mock((_content: string) => false);
    const { result, sendMessage } = renderSubmit({ beforeSend });
    await submit(result);

    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(useChannelReferenceStore.getState().reference).toEqual(
      stagedChannelReference,
    );
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

describe("useComposerSubmit Eyes frame", () => {
  test("a message that becomes a turn asks the camera for its frame", async () => {
    useComposerStore.getState().setInput("what am I holding?");
    const { result, sendMessage } = renderSubmit();
    await submit(result);

    expect(uploadSightFrameAttachment).toHaveBeenCalledTimes(1);
    expect(uploadSightFrameAttachment).toHaveBeenCalledWith("assistant-1");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("a command the send resolves locally never reaches the camera", async () => {
    // GIVEN a submit that ends in an ephemeral card or the Doctor panel
    // WHEN it goes through
    // THEN no frame is captured, resized or uploaded for it, while the send
    // still receives the command and resolves it as it always has.
    const { result, sendMessage } = renderSubmit();
    for (const command of [
      "/status",
      "  /clean  ",
      "/doctor fix my profiles",
    ]) {
      await act(async () => {
        await result.current.submitMessage(command);
      });
    }

    expect(uploadSightFrameAttachment).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  test("the frame skipped by a command is still there for the next message", async () => {
    // Nothing about the skip touches the store, so the keep it is holding
    // survives to ride along with the first submit that becomes a turn.
    const { result } = renderSubmit();
    await act(async () => {
      await result.current.submitMessage("/status");
    });
    expect(uploadSightFrameAttachment).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.submitMessage("and now look at this");
    });
    expect(uploadSightFrameAttachment).toHaveBeenCalledTimes(1);
  });
});

describe("useComposerSubmit vision gate", () => {
  test("no frame is attached where an image would fail the turn", async () => {
    // GIVEN a legacy assistant whose active profile has no vision, the same
    // condition that makes the drop/pick path filter images out
    // WHEN a message that becomes a turn is submitted
    // THEN the camera is never asked for a frame, and the message still goes.
    useComposerStore.getState().setInput("what am I holding?");
    const { result, sendMessage } = renderSubmit({
      imageAttachmentsAllowed: false,
    });
    await submit(result);

    expect(uploadSightFrameAttachment).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
