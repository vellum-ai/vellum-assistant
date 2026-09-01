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
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { useEffect } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

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

// How far short of a deadline {@link holdShortOfTheDeadline} parks the clock,
// and so how long the hook's own `setTimeout` waits: short enough to spend on
// a real clock, long enough not to spin.
const SHORT_OF_THE_DEADLINE_MS = 25;

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
});

/**
 * Queue reclaims and let the hook arm against a clock parked just short of the
 * deadline they derive. Returns that deadline, for the caller to step past.
 *
 * The wait under test is tens of seconds long, so something has to give. What
 * gives is `Date.now()` rather than the timers: the hook keeps the ordinary
 * `setTimeout` it ships with, and its arm comes out a few real milliseconds
 * instead. Replacing the timers instead would take React's own scheduling with
 * them, since a faked timer that writes to the store leaves work `act` can no
 * longer settle.
 *
 * The clock is parked rather than merely set, so an arm that fires while the
 * caller is asserting the wait finds nothing due and simply arms again.
 */
async function holdShortOfTheDeadline(queue: () => void): Promise<number> {
  let deadline = 0;
  await act(async () => {
    queue();
    const pending = useLiveVoiceStore.getState().sightFramesToReclaim;
    deadline = Math.max(...pending.map((entry) => entry.notBefore ?? 0));
    setSystemTime(new Date(deadline - SHORT_OF_THE_DEADLINE_MS));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return deadline;
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
    const generation = startSession();
    renderHook(() => useSightFrameReclaimer());
    sendLiveVoiceSightFrame("att-1", generation);
    sendLiveVoiceSightFrame("att-2", generation);

    const deadline = await holdShortOfTheDeadline(() => {
      useLiveVoiceStore.getState().reset({ sessionContinues: true });
    });

    expect(deleteChatAttachment).not.toHaveBeenCalled();
    expect(useLiveVoiceStore.getState().sightFramesToReclaim).toHaveLength(2);

    // Once the daemon has had its time, the link-aware delete decides: a frame
    // that persisted meanwhile is refused, one that was lost is collected.
    setSystemTime(new Date(deadline + 1));
    await waitFor(() => {
      expect(useLiveVoiceStore.getState().sightFramesToReclaim).toEqual([]);
    });

    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-2");
  });

  test("holds a terminal reset's the same way", async () => {
    const generation = startSession();
    renderHook(() => useSightFrameReclaimer());
    sendLiveVoiceSightFrame("att-1", generation);

    const deadline = await holdShortOfTheDeadline(() => {
      useLiveVoiceStore.getState().reset();
    });
    expect(deleteChatAttachment).not.toHaveBeenCalled();

    setSystemTime(new Date(deadline + 1));
    await waitFor(() => {
      expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
    });
  });

  test("stops arming once the queue is empty", async () => {
    const generation = startSession();
    renderHook(() => useSightFrameReclaimer());
    sendLiveVoiceSightFrame("att-1", generation);

    const deadline = await holdShortOfTheDeadline(() => {
      useLiveVoiceStore.getState().reset();
    });

    setSystemTime(new Date(deadline + 1));
    await waitFor(() => {
      expect(deleteChatAttachment).toHaveBeenCalledTimes(1);
    });

    // Nothing is queued, so nothing is waiting to fire: running the clock on
    // must not re-issue the delete this already made.
    setSystemTime(new Date(deadline + PAST_EVERY_DEADLINE_MS));
    await act(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, SHORT_OF_THE_DEADLINE_MS * 4),
      );
    });

    expect(deleteChatAttachment).toHaveBeenCalledTimes(1);
  });

  test("a refusal-routed reclaim does not wait", async () => {
    // The assistant answered for these and reclaimed its own side, so there is
    // nothing left to settle and no reason to hold them.
    const generation = startSession();
    renderHook(() => useSightFrameReclaimer());
    sendLiveVoiceSightFrame("att-1", generation);

    await act(async () => {
      useLiveVoiceStore.getState().noteSightFrameRefused(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(deleteChatAttachment).toHaveBeenCalledWith(ASSISTANT_ID, "att-1");
    expect(useLiveVoiceStore.getState().sightFramesToReclaim).toEqual([]);
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
