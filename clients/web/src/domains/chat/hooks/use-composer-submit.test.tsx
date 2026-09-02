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
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

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

/** The attachment a successful frame upload hands back. */
function sightFrameAttachment(): DisplayAttachment {
  return {
    id: "sight-frame-1",
    filename: "sight-1.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 2048,
    previewUrl: null,
    thumbnailUrl: null,
  };
}

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
  const baseParams: UseComposerSubmitParams = {
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
  };
  const { result, rerender } = renderHook(
    (props: UseComposerSubmitParams) => useComposerSubmit(props),
    { initialProps: baseParams },
  );
  return {
    result,
    sendMessage,
    // Re-render the hook with changed params, as the chat route does when a
    // profile switch recomputes what it passes down.
    rerenderWith: (next: Partial<UseComposerSubmitParams>) => {
      rerender({ ...baseParams, ...next });
    },
  };
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
  // Restored explicitly: a case that swaps in a slow upload must not leave it
  // standing for the next one, which would hang on a frame that never arrives.
  uploadSightFrameAttachment.mockImplementation(async () => null);
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
  /** Stand the user on the submit's own thread, so the live gate applies. */
  function standOnSubmitThread() {
    useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-1" });
    useConversationStore.setState({ activeConversationId: "conv-1" });
  }

  /** Move the user to another conversation, as a mid-upload navigation does. */
  function moveToAnotherThread() {
    useConversationStore.setState({ activeConversationId: "conv-2" });
  }

  afterEach(() => {
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    useConversationStore.setState({ activeConversationId: null });
  });

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

  test("a profile losing vision mid-upload keeps the frame off the message", async () => {
    // GIVEN Eyes is on, the frame upload is slow, and the user stays on the
    // thread they submitted from, so the profile change is that thread's own
    standOnSubmitThread();
    let settleUpload!: (value: DisplayAttachment | null) => void;
    uploadSightFrameAttachment.mockImplementation(
      () =>
        new Promise<DisplayAttachment | null>((resolve) => {
          settleUpload = resolve;
        }),
    );
    useComposerStore.getState().setInput("what am I holding?");
    const { result, sendMessage, rerenderWith } = renderSubmit();

    let submission: Promise<void> = Promise.resolve();
    await act(async () => {
      submission = result.current.submitMessage();
      await Promise.resolve();
    });

    // WHEN the active profile flips to one without vision while it is pending
    await act(async () => {
      rerenderWith({ imageAttachmentsAllowed: false });
    });
    await act(async () => {
      settleUpload(sightFrameAttachment());
      await submission;
    });

    // THEN the message still goes, without the frame
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1] ?? []).toHaveLength(0);
  });

  test("a frame uploaded under a gate that held rides the message", async () => {
    // The positive control for the test above: same slow upload, no flip.
    let settleUpload!: (value: DisplayAttachment | null) => void;
    uploadSightFrameAttachment.mockImplementation(
      () =>
        new Promise<DisplayAttachment | null>((resolve) => {
          settleUpload = resolve;
        }),
    );
    useComposerStore.getState().setInput("what am I holding?");
    const { result, sendMessage } = renderSubmit();

    let submission: Promise<void> = Promise.resolve();
    await act(async () => {
      submission = result.current.submitMessage();
      await Promise.resolve();
    });
    await act(async () => {
      settleUpload(sightFrameAttachment());
      await submission;
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const attachments = sendMessage.mock.calls[0]?.[1] ?? [];
    expect(attachments.map((a) => a.id)).toEqual(["sight-frame-1"]);
  });

  test("navigating to a non-vision thread does not discard the frame", async () => {
    // GIVEN a vision-capable thread's submit with its upload pending
    standOnSubmitThread();
    let settleUpload!: (value: DisplayAttachment | null) => void;
    uploadSightFrameAttachment.mockImplementation(
      () =>
        new Promise<DisplayAttachment | null>((resolve) => {
          settleUpload = resolve;
        }),
    );
    useComposerStore.getState().setInput("what am I holding?");
    const { result, sendMessage, rerenderWith } = renderSubmit();

    let submission: Promise<void> = Promise.resolve();
    await act(async () => {
      submission = result.current.submitMessage();
      await Promise.resolve();
    });

    // WHEN the user moves to a legacy thread whose gate answers false, so the
    // live ref now describes somebody else's profile
    moveToAnotherThread();
    await act(async () => {
      rerenderWith({ imageAttachmentsAllowed: false });
    });
    await act(async () => {
      settleUpload(sightFrameAttachment());
      await submission;
    });

    // THEN the frame still rides: the submit's own thread never lost vision
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const attachments = sendMessage.mock.calls[0]?.[1] ?? [];
    expect(attachments.map((a) => a.id)).toEqual(["sight-frame-1"]);
  });

  test("navigating to a vision thread does not arm a non-vision submit", async () => {
    // GIVEN the submit's own thread cannot take images, and its delivery is
    // parked behind an earlier send still in flight, so its gate is read only
    // after the navigation below
    standOnSubmitThread();
    const sendSettles: Array<() => void> = [];
    const slowSend = mock(
      async (
        _content: string,
        _attachments?: DisplayAttachment[],
        _opts?: { bypassSecretCheck?: boolean },
      ) =>
        new Promise<void>((resolve) => {
          sendSettles.push(resolve);
        }),
    );
    const { result, rerenderWith } = renderSubmit({
      imageAttachmentsAllowed: false,
      sendMessage: slowSend,
    });

    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.submitMessage("look first");
      second = result.current.submitMessage("what am I holding?");
      await Promise.resolve();
    });

    // WHEN the user moves to a thread whose gate answers true before the
    // second delivery runs
    moveToAnotherThread();
    await act(async () => {
      rerenderWith({ imageAttachmentsAllowed: true, sendMessage: slowSend });
    });
    await act(async () => {
      sendSettles[0]?.();
      await first;
      sendSettles[1]?.();
      await second;
    });

    // THEN no frame was ever requested for the incompatible original thread
    expect(uploadSightFrameAttachment).not.toHaveBeenCalled();
    expect(slowSend).toHaveBeenCalledTimes(2);
  });
});

describe("useComposerSubmit delivery order", () => {
  test("two rapid submits reach the send in submit order", async () => {
    // GIVEN the frame upload for the first message resolves AFTER the second
    // message's, which is what a second, smaller frame does
    const pending: Array<(value: DisplayAttachment | null) => void> = [];
    uploadSightFrameAttachment.mockImplementation(
      () =>
        new Promise<DisplayAttachment | null>((resolve) => {
          pending.push(resolve);
        }),
    );
    const { result, sendMessage } = renderSubmit();

    // WHEN both are submitted before either upload settles
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.submitMessage("first message");
      second = result.current.submitMessage("second message");
      await Promise.resolve();
    });

    // Only the first delivery is running: the second is parked behind it, so
    // its upload has not even been asked for yet.
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending[0]?.(null);
      await first;
      pending[1]?.(null);
      await second;
    });

    // THEN the assistant receives them the way they were written.
    expect(sendMessage.mock.calls.map((call) => call[0])).toEqual([
      "first message",
      "second message",
    ]);
  });

  test("a failed delivery does not wedge the ones behind it", async () => {
    const failing = mock(
      async (
        _content: string,
        _attachments?: DisplayAttachment[],
        _opts?: { bypassSecretCheck?: boolean },
      ): Promise<void> => {
        throw new Error("send failed");
      },
    );
    const { result } = renderSubmit({ sendMessage: failing });

    await act(async () => {
      await result.current.submitMessage("doomed").catch(() => {});
      await result.current.submitMessage("still goes").catch(() => {});
    });

    expect(failing.mock.calls.map((call) => call[0])).toEqual([
      "doomed",
      "still goes",
    ]);
  });
});
