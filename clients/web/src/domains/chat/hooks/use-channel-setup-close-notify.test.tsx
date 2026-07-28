/**
 * Tests for the channel-setup close-notify watcher hook.
 *
 * The hook subscribes directly to the viewer store (not render-path
 * selectors), so it must observe every wizard-visibility transition: explicit
 * closes, another panel replacing the drawer, and store mutations made from
 * any component tree. It must stay quiet for same-wizard re-shows and stop
 * observing after unmount.
 *
 * NOTE: `bun mock.module` can leak across files — run this file singly:
 *   bun test src/domains/chat/hooks/use-channel-setup-close-notify.test.tsx
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";

import type { ChannelSetupPayload } from "@/stores/viewer-store";

import * as closeNotifyModule from "@/domains/chat/channel-setup-close-notify";

let notifyCalls: ChannelSetupPayload[] = [];

mock.module("@/domains/chat/channel-setup-close-notify", () => ({
  ...closeNotifyModule,
  notifyChannelSetupClosed: (payload: ChannelSetupPayload) => {
    notifyCalls.push(payload);
    return Promise.resolve();
  },
}));

const { useChannelSetupCloseNotify } =
  await import("./use-channel-setup-close-notify");
const { useViewerStore } = await import("@/stores/viewer-store");

function Harness() {
  useChannelSetupCloseNotify();
  return null;
}

const PAYLOAD: ChannelSetupPayload = {
  channel: "slack",
  assistantId: "a1",
  assistantName: "Vellum",
  conversationId: "c1",
};

afterEach(() => {
  cleanup();
  notifyCalls = [];
  act(() => {
    useViewerStore.getState().reset();
  });
});

describe("useChannelSetupCloseNotify", () => {
  test("fires once with the open-time payload when the drawer closes", () => {
    render(<Harness />);

    act(() => {
      useViewerStore.getState().openChannelSetup(PAYLOAD);
    });
    expect(notifyCalls).toHaveLength(0);

    act(() => {
      useViewerStore.getState().closeChannelSetup();
    });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toEqual(PAYLOAD);
  });

  test("stays quiet when the drawer was never open", () => {
    render(<Harness />);

    act(() => {
      useViewerStore.getState().closeChannelSetup();
    });
    expect(notifyCalls).toHaveLength(0);
  });

  test("treats another panel replacing the drawer as a close", () => {
    // openToolDetail changes mainView but leaves activeChannelSetup set, and
    // resolveViewBefore collapses overlay views so the wizard never returns —
    // the drawer is gone for good and the assistant must still be notified.
    render(<Harness />);

    act(() => {
      useViewerStore.getState().openChannelSetup(PAYLOAD);
    });
    act(() => {
      useViewerStore.getState().openToolDetail({
        toolCallId: "t1",
        toolName: "bash",
        title: "Running command",
        activity: "",
        input: {},
        status: "completed",
      });
    });

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toEqual(PAYLOAD);
  });

  test("stays quiet when the same wizard is re-shown over itself", () => {
    // The assistant re-issuing ui_show for the channel it already has open
    // swaps the payload object without closing anything — notifying would
    // trigger a premature verification.
    render(<Harness />);

    act(() => {
      useViewerStore.getState().openChannelSetup(PAYLOAD);
    });
    act(() => {
      useViewerStore.getState().openChannelSetup({ ...PAYLOAD });
    });

    expect(notifyCalls).toHaveLength(0);
  });

  test("notifies the replaced wizard when a different one takes its place", () => {
    render(<Harness />);

    act(() => {
      useViewerStore.getState().openChannelSetup(PAYLOAD);
    });
    act(() => {
      useViewerStore.getState().openChannelSetup({
        ...PAYLOAD,
        channel: "telegram",
        conversationId: "c2",
      });
    });

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]?.channel).toBe("slack");
  });

  test("fires again on a re-open → re-close cycle", () => {
    render(<Harness />);

    act(() => {
      useViewerStore.getState().openChannelSetup(PAYLOAD);
    });
    act(() => {
      useViewerStore.getState().closeChannelSetup();
    });
    act(() => {
      useViewerStore.getState().openChannelSetup({
        ...PAYLOAD,
        channel: "telegram",
      });
    });
    act(() => {
      useViewerStore.getState().closeChannelSetup();
    });

    expect(notifyCalls).toHaveLength(2);
    expect(notifyCalls[1]?.channel).toBe("telegram");
  });

  test("stops observing after unmount", () => {
    const { unmount } = render(<Harness />);

    act(() => {
      useViewerStore.getState().openChannelSetup(PAYLOAD);
    });
    unmount();
    act(() => {
      useViewerStore.getState().closeChannelSetup();
    });

    expect(notifyCalls).toHaveLength(0);
  });
});
