/**
 * The channel drawer's slice of the viewer store: opening, toggling, and the
 * settling rule that keeps a stale thread off the screen.
 *
 * Lives with the feature rather than in `viewer-store.test.ts`, keeping the
 * sidecar's store behavior and its tests in one unit.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { isSameChannelSidecarRef, useViewerStore } from "@/stores/viewer-store";

const SLACK_THREAD = { conversationId: "conv-1", channelId: "slack" };
const TELEGRAM_THREAD = { conversationId: "conv-2", channelId: "telegram" };

describe("isSameChannelSidecarRef", () => {
  test("matches on both conversation and channel", () => {
    const ref = { conversationId: "conv-1", channelId: "slack" };

    expect(isSameChannelSidecarRef(ref, { ...ref })).toBe(true);
    expect(
      isSameChannelSidecarRef(ref, {
        conversationId: "conv-2",
        channelId: "slack",
      }),
    ).toBe(false);
    expect(isSameChannelSidecarRef(ref, null)).toBe(false);
    expect(isSameChannelSidecarRef(null, ref)).toBe(false);
  });
});

describe("channel transcript viewer state", () => {
  beforeEach(() => {
    useViewerStore.getState().reset();
  });

  test("opening records the thread and remembers where to go back to", () => {
    useViewerStore.getState().openChannelTranscript(SLACK_THREAD);

    const state = useViewerStore.getState();
    expect(state.mainView).toBe("channel-transcript");
    expect(state.activeChannelTranscript).toEqual(SLACK_THREAD);
    expect(state.viewBeforeChannelTranscript).toBe("chat");
  });

  test("closing restores the previous view and drops the thread", () => {
    useViewerStore.getState().openChannelTranscript(SLACK_THREAD);
    useViewerStore.getState().closeChannelTranscript();

    const state = useViewerStore.getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeChannelTranscript).toBeNull();
  });

  test("the header control toggles the same thread shut", () => {
    useViewerStore.getState().toggleChannelTranscript(SLACK_THREAD);
    expect(useViewerStore.getState().mainView).toBe("channel-transcript");

    useViewerStore.getState().toggleChannelTranscript(SLACK_THREAD);
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("toggling a different thread switches rather than closes", () => {
    useViewerStore.getState().toggleChannelTranscript(SLACK_THREAD);
    useViewerStore.getState().toggleChannelTranscript(TELEGRAM_THREAD);

    const state = useViewerStore.getState();
    expect(state.mainView).toBe("channel-transcript");
    expect(state.activeChannelTranscript).toEqual(TELEGRAM_THREAD);
  });

  test("Escape unwinds it like every other overlay", () => {
    useViewerStore.getState().openChannelTranscript(SLACK_THREAD);

    expect(useViewerStore.getState().closeActiveOverlay()).toBe(true);
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("stacks under a later overlay and unwinds back to it", () => {
    useViewerStore.getState().openChannelTranscript(SLACK_THREAD);
    useViewerStore.getState().openSkillDetail("skill-1");

    expect(useViewerStore.getState().closeActiveOverlay()).toBe(true);
    // The skill panel remembers the channel drawer was not a base view, so it
    // returns to chat rather than reopening a thread the user left.
    expect(useViewerStore.getState().mainView).toBe("chat");
  });

  test("reconciling to the same thread leaves the drawer open", () => {
    useViewerStore.getState().openChannelTranscript(SLACK_THREAD);
    useViewerStore.getState().reconcileChannelTranscript({ ...SLACK_THREAD });

    expect(useViewerStore.getState().mainView).toBe("channel-transcript");
  });

  test("reconciling to another conversation closes the drawer", () => {
    useViewerStore.getState().openChannelTranscript(SLACK_THREAD);
    useViewerStore.getState().reconcileChannelTranscript(TELEGRAM_THREAD);

    const state = useViewerStore.getState();
    expect(state.mainView).toBe("chat");
    expect(state.activeChannelTranscript).toBeNull();
  });

  test("reconciling to nothing closes the drawer", () => {
    // What a lost binding, or the flag going off, looks like from here.
    useViewerStore.getState().openChannelTranscript(SLACK_THREAD);
    useViewerStore.getState().reconcileChannelTranscript(null);

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeChannelTranscript).toBeNull();
  });

  test("reconciling is inert when no channel drawer is open", () => {
    useViewerStore.getState().openSkillDetail("skill-1");
    useViewerStore.getState().reconcileChannelTranscript(null);

    expect(useViewerStore.getState().mainView).toBe("skill-detail");
  });

  test("reconciling under another overlay clears the thread, not the view", () => {
    // The drawer's identity outlives it being covered: another overlay opens
    // on top, then the conversation switches and the sidecar reconciles. The
    // stale thread must go, but the overlay on screen owns `mainView`.
    useViewerStore.getState().openChannelTranscript(SLACK_THREAD);
    useViewerStore.getState().openSkillDetail("skill-1");
    useViewerStore.getState().reconcileChannelTranscript(null);

    const state = useViewerStore.getState();
    expect(state.mainView).toBe("skill-detail");
    expect(state.activeChannelTranscript).toBeNull();
  });
});
