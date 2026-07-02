/**
 * Tests for the channel-setup close-notify hook.
 *
 * The hook is the glue between the viewer store and the notify helper: it
 * must fire exactly once per open → close transition of the channel setup
 * drawer, with the payload captured at open time, and stay quiet otherwise.
 *
 * NOTE: `bun mock.module` can leak across files — run this file singly:
 *   bun test src/domains/chat/hooks/use-channel-setup-close-notify.test.tsx
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";

import type { ChannelSetupPayload } from "@/stores/viewer-store";

let notifyCalls: ChannelSetupPayload[] = [];

mock.module("@/domains/chat/channel-setup-close-notify", () => ({
  buildChannelSetupClosedMessage: (channel: string) =>
    `[User action on channel_setup panel: closed the ${channel} setup wizard]`,
  notifyChannelSetupClosed: (payload: ChannelSetupPayload) => {
    notifyCalls.push(payload);
    return Promise.resolve();
  },
}));

const { useChannelSetupCloseNotify } = await import(
  "./use-channel-setup-close-notify"
);
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
});
