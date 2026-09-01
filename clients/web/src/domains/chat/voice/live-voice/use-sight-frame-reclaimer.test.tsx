/**
 * The session-lifetime drain for camera-frame uploads an assistant refused.
 *
 * What is under test is the thing the room's own hook cannot do: act while the
 * room is not mounted. So the cases are about lifetime rather than about
 * deleting, which is one call to a faked API.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { useEffect } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";

const deleteChatAttachment = mock(
  async (_assistantId: string, _attachmentId: string) => true,
);
mock.module("@/domains/chat/api/messages", () => ({ deleteChatAttachment }));

const { useSightFrameReclaimer } = await import("./use-sight-frame-reclaimer");
const { useLiveVoiceStore, sendLiveVoiceSightFrame, PER_JOB_CEILING_MS } =
  await import("./live-voice-store");
const { makeControlsSpies, seedLiveVoiceSession } =
  await import("./live-voice-fakes.test-helper");

const ASSISTANT_ID = "asst_sight";

// Comfortably past every deadline these tests derive, which queue at most a
// handful of jobs ahead.
const PAST_EVERY_DEADLINE_MS = 10 * PER_JOB_CEILING_MS;

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
  useLiveVoiceStore
    .getState()
    .takeDueSightFrameReclaims(Number.MAX_SAFE_INTEGER);
});

afterEach(() => {
  cleanup();
  setSystemTime();
  jest.useRealTimers();
});

/**
 * Run `body` on a clock this test owns.
 *
 * Scoped rather than global: fake timers freeze the ordinary `setTimeout(0)`
 * settles the other cases wait on, so only the cases about the delay take
 * them, and those settle with microtasks alone.
 */
async function onAFakeClock(
  body: (advanceBy: (ms: number) => void) => Promise<void>,
): Promise<void> {
  const base = new Date("2026-09-01T00:00:00Z");
  setSystemTime(base);
  jest.useFakeTimers();
  let elapsed = 0;
  try {
    await body((ms) => {
      elapsed += ms;
      setSystemTime(new Date(base.getTime() + elapsed));
      jest.advanceTimersByTime(ms);
    });
  } finally {
    jest.useRealTimers();
    setSystemTime();
  }
}

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

  test("an upload queued after the render is drained, not cleared undeleted", async () => {
    // The window the take closes. This render captured the queue as it stood,
    // and a refusal can land before the effect body runs; a drain that cleared
    // the whole queue while deleting only what it captured would wipe that
    // entry with nothing ever collecting it.
    const generation = startSession();
    useLiveVoiceStore.getState().noteSightFrameSent("att-1");
    useLiveVoiceStore.getState().noteSightFrameRefused(true);

    let queuedLate = false;
    await act(async () => {
      renderHook(() => {
        // Declared first, so its effect runs before the reclaimer's in the
        // same commit: exactly between the reclaimer's capture and its body.
        useEffect(() => {
          if (queuedLate) {
            return;
          }
          queuedLate = true;
          const store = useLiveVoiceStore.getState();
          store.noteSightFrameSent("att-2");
          store.noteSightFrameRefused(true);
        });
        useSightFrameReclaimer();
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-2");
    expect(useLiveVoiceStore.getState().sightFramesToReclaim).toEqual([]);
    expect(generation).toBe(useLiveVoiceStore.getState().sessionGeneration);
  });

  test("holds a reconnect's unacknowledged sends until they settle", async () => {
    // The daemon persists one image at a time per conversation, so a keep can
    // still be queued behind another when the socket closes. Deleting straight
    // away would make its persist find nothing and drop a frame that was going
    // to land, with no open socket left to say so.
    await onAFakeClock(async (advanceBy) => {
      const generation = startSession();
      renderHook(() => useSightFrameReclaimer());
      sendLiveVoiceSightFrame("att-1", generation);
      sendLiveVoiceSightFrame("att-2", generation);

      await act(async () => {
        useLiveVoiceStore.getState().reset({ sessionContinues: true });
        await Promise.resolve();
      });

      expect(deleteChatAttachment).not.toHaveBeenCalled();
      expect(useLiveVoiceStore.getState().sightFramesToReclaim).toHaveLength(2);

      // Once the daemon has had its time, the link-aware delete decides: a
      // frame that persisted meanwhile is refused, one that was lost is
      // collected.
      await act(async () => {
        advanceBy(PAST_EVERY_DEADLINE_MS);
        await Promise.resolve();
      });

      expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
      expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-2");
      expect(useLiveVoiceStore.getState().sightFramesToReclaim).toEqual([]);
    });
  });

  test("holds a terminal reset's the same way", async () => {
    await onAFakeClock(async (advanceBy) => {
      const generation = startSession();
      renderHook(() => useSightFrameReclaimer());
      sendLiveVoiceSightFrame("att-1", generation);

      await act(async () => {
        useLiveVoiceStore.getState().reset();
        await Promise.resolve();
      });
      expect(deleteChatAttachment).not.toHaveBeenCalled();

      await act(async () => {
        advanceBy(PAST_EVERY_DEADLINE_MS);
        await Promise.resolve();
      });

      expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
    });
  });

  test("stops arming once the queue is empty", async () => {
    await onAFakeClock(async (advanceBy) => {
      const generation = startSession();
      renderHook(() => useSightFrameReclaimer());
      sendLiveVoiceSightFrame("att-1", generation);
      await act(async () => {
        useLiveVoiceStore.getState().reset();
        await Promise.resolve();
      });

      await act(async () => {
        advanceBy(PAST_EVERY_DEADLINE_MS);
        await Promise.resolve();
      });
      expect(deleteChatAttachment).toHaveBeenCalledTimes(1);

      // Nothing is queued, so nothing is waiting to fire: running the clock on
      // must not re-issue the delete this already made.
      await act(async () => {
        advanceBy(PAST_EVERY_DEADLINE_MS * 4);
        await Promise.resolve();
      });

      expect(deleteChatAttachment).toHaveBeenCalledTimes(1);
    });
  });

  test("a refusal-routed reclaim does not wait", async () => {
    // The assistant answered for these and reclaimed its own side, so there is
    // nothing left to settle and no reason to hold them.
    await onAFakeClock(async () => {
      const generation = startSession();
      renderHook(() => useSightFrameReclaimer());
      sendLiveVoiceSightFrame("att-1", generation);

      await act(async () => {
        useLiveVoiceStore.getState().noteSightFrameRefused(true);
        await Promise.resolve();
      });

      expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
    });
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
