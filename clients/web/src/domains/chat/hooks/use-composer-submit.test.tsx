/**
 * Tests for `useComposerSubmit`: the optional `beforeSend` gate (a blocking
 * gate must cancel the send losslessly, with draft, attachments, staged
 * quotes, and the staged channel reference untouched, while a passing or
 * omitted gate leaves the submit path unchanged), the staged channel
 * reference's send behavior (sendable alone, leads mixed content, clears on
 * send), and the mid-dictation send path (LUM-3432: a send pressed while
 * words are still being spoken finishes dictation and sends the finished
 * transcript, never the draft that was sitting there). Uses the real
 * composer, quote-reply, channel-reference, and voice-recording stores,
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
import { registerPushToTalkTarget } from "@/domains/chat/voice/push-to-talk-target";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";

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

const stagedChannelReference: ChannelReference = {
  messageId: "msg-ext-1",
  conversationId: "conv-1",
  channelId: "slack",
  channelLabel: "Slack",
  senderName: "Alice",
  snippet: "deploy went red on the last step",
  isTruncated: false,
};

let unregisterVoiceTarget: (() => void) | null = null;

beforeEach(() => {
  useComposerStore.getState().setInput("");
  useComposerStore.getState().resetAttachments();
  useQuoteReplyStore.getState().clearStagedQuotes();
  useChannelReferenceStore.setState({ reference: null });
});

afterEach(() => {
  cleanup();
  unregisterVoiceTarget?.();
  unregisterVoiceTarget = null;
  useVoiceRecordingStore.getState().reset();
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

// ---------------------------------------------------------------------------
// Mid-dictation send (LUM-3432)
// ---------------------------------------------------------------------------

/**
 * Stands in for `VoiceInputButton`: stopping ends capture, then the
 * transcript lands in the composer and only after that does the session
 * finalize. Passing `transcript: null` models a session that ended without
 * producing any text.
 */
function recordingWithTranscript(transcript: string | null): void {
  const voice = useVoiceRecordingStore.getState();
  voice.startRecording();
  unregisterVoiceTarget = registerPushToTalkTarget({
    start: () => {},
    stop: () => {
      useVoiceRecordingStore.getState().stopRecording();
      setTimeout(() => {
        if (transcript === null) {
          useVoiceRecordingStore.getState().fail("audio-capture");
          return;
        }
        useComposerStore
          .getState()
          .setInput((current) =>
            current ? `${current} ${transcript}` : transcript,
          );
        useVoiceRecordingStore.getState().finalize();
      }, 0);
    },
  });
}

describe("useComposerSubmit during dictation", () => {
  test("sends the finished transcript, not the draft that was on screen", async () => {
    useComposerStore.getState().setInput("");
    recordingWithTranscript("the whole request, spoken in full");

    const { result, sendMessage } = renderSubmit();
    await submit(result);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(
      "the whole request, spoken in full",
    );
  });

  test("a stale fragment in the composer never goes out on its own", async () => {
    // The reported failure: an earlier session left a fragment behind, the
    // user re-dictated, and Send shipped the fragment mid-utterance.
    useComposerStore.getState().setInput("can you create a list");
    recordingWithTranscript("with all the constraints that mattered");

    const { result, sendMessage } = renderSubmit();
    await submit(result);

    expect(sendMessage.mock.calls[0]?.[0]).toBe(
      "can you create a list with all the constraints that mattered",
    );
  });

  test("cancels the send and keeps the draft when no transcript survives", async () => {
    useComposerStore.getState().setInput("older draft");
    recordingWithTranscript(null);

    const { result, sendMessage } = renderSubmit();
    await submit(result);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(useComposerStore.getState().input).toBe("older draft");
  });

  test("an explicit override is its own payload and does not wait", async () => {
    // Starter prompts and the secret guard's re-send carry their own text,
    // so they must not be held behind an unrelated dictation session.
    useComposerStore.getState().setInput("");
    let stopped = false;
    useVoiceRecordingStore.getState().startRecording();
    unregisterVoiceTarget = registerPushToTalkTarget({
      start: () => {},
      stop: () => {
        stopped = true;
      },
    });

    const { result, sendMessage } = renderSubmit();
    await act(async () => {
      await result.current.submitMessage("a starter prompt");
    });

    expect(stopped).toBe(false);
    expect(sendMessage.mock.calls[0]?.[0]).toBe("a starter prompt");
  });

  test("leaves an ordinary send untouched when nothing is recording", async () => {
    useComposerStore.getState().setInput("typed by hand");

    const { result, sendMessage } = renderSubmit();
    await submit(result);

    expect(sendMessage.mock.calls[0]?.[0]).toBe("typed by hand");
  });
});
