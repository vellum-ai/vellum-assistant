/**
 * The session-lifetime drain for camera-frame uploads an assistant refused.
 *
 * What is under test is the thing the room's own hook cannot do: act while the
 * room is not mounted. So the cases are about lifetime rather than about
 * deleting, which is one call to a faked API.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

const deleteChatAttachment = mock(
  async (_assistantId: string, _attachmentId: string) => true,
);
mock.module("@/domains/chat/api/messages", () => ({ deleteChatAttachment }));

const { useSightFrameReclaimer } = await import("./use-sight-frame-reclaimer");
const { useLiveVoiceStore, sendLiveVoiceSightFrame } =
  await import("./live-voice-store");
const { makeControlsSpies, seedLiveVoiceSession } =
  await import("./live-voice-fakes.test-helper");

const ASSISTANT_ID = "asst_sight";

/** Put a running session on the store, bound to an assistant. */
function startSession() {
  const controls = makeControlsSpies();
  seedLiveVoiceSession("listening", {
    assistantId: ASSISTANT_ID,
    conversationId: "conv_sight",
    controls,
  });
  return useLiveVoiceStore.getState().sessionGeneration;
}

beforeEach(() => {
  deleteChatAttachment.mockClear();
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().clearSightFramesToReclaim();
});

afterEach(() => {
  cleanup();
});

describe("useSightFrameReclaimer", () => {
  test("gives back an upload the assistant refused but never stored", async () => {
    const generation = startSession();
    renderHook(() => useSightFrameReclaimer());
    sendLiveVoiceSightFrame("att-1", generation);

    await act(async () => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
    // Drained, so a later refusal cannot re-issue this delete.
    expect(useLiveVoiceStore.getState().sightFramesToReclaim).toEqual([]);
  });

  test("deletes uploads refused while the room was not mounted, after the call ends", async () => {
    // The case this hook exists for. A minimized room is unmounted, so nothing
    // in the room can consume the refusal, and ending the call would take the
    // queue with it if the queue were session state.
    const generation = startSession();
    renderHook(() => useSightFrameReclaimer());
    sendLiveVoiceSightFrame("att-1", generation);

    // Refusal lands with no room mounted, then the user hangs up.
    act(() => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
      useLiveVoiceStore.getState().reset();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
  });

  test("deletes against the assistant that held the upload, not the current one", async () => {
    // The queue carries the assistant for exactly this: a drain after the
    // session ended must not aim at whoever is current now.
    const generation = startSession();
    renderHook(() => useSightFrameReclaimer());
    sendLiveVoiceSightFrame("att-1", generation);

    act(() => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
      useLiveVoiceStore.getState().reset();
      seedLiveVoiceSession("listening", {
        assistantId: "asst_other",
        conversationId: "conv_other",
        controls: makeControlsSpies(),
      });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
    expect(deleteChatAttachment).not.toHaveBeenCalledWith(
      "asst_other",
      "att-1",
    );
  });

  test("a routine refusal queues nothing to delete", async () => {
    // An assistant that understands the frame reclaims what it could not
    // persist, so deleting would race it.
    const generation = startSession();
    renderHook(() => useSightFrameReclaimer());
    sendLiveVoiceSightFrame("att-1", generation);

    await act(async () => {
      useLiveVoiceStore.getState().noteSightFrameRefused(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(deleteChatAttachment).not.toHaveBeenCalled();
  });

  test("an empty queue issues nothing", async () => {
    startSession();
    renderHook(() => useSightFrameReclaimer());

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(deleteChatAttachment).not.toHaveBeenCalled();
  });
});
