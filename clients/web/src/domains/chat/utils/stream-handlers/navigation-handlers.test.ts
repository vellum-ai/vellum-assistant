/**
 * `open_panel` acknowledgment.
 *
 * The daemon holds the emitting `ui_show channel_setup` tool call open until
 * a client confirms the panel rendered, so the handler must ack after opening
 * and nack (with a reason) when it cannot open — a silent drop would surface
 * to the model as a timeout it can't distinguish from a disconnected client.
 * Events without a `surfaceId` come from daemons that expect no ack.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import type { OpenPanelEvent } from "@vellumai/assistant-api";

const submitSurfaceActionCalls: Array<{
  assistantId: string;
  surfaceId: string;
  actionId: string;
  data?: Record<string, unknown>;
  conversationId?: string;
}> = [];

mock.module("@/domains/chat/api/surfaces", () => ({
  submitSurfaceAction: async (
    assistantId: string,
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
    conversationId?: string,
  ) => {
    submitSurfaceActionCalls.push({
      assistantId,
      surfaceId,
      actionId,
      data,
      conversationId,
    });
    return { ok: true };
  },
}));

const { handleOpenPanel } =
  await import("@/domains/chat/utils/stream-handlers/navigation-handlers");
const { useViewerStore } = await import("@/stores/viewer-store");

function makeCtx(
  overrides: Partial<StreamHandlerContext> = {},
): StreamHandlerContext {
  return {
    assistantId: "ast-1",
    streamContext: { assistantId: "ast-1", conversationId: "conv-1" },
    ...overrides,
  } as unknown as StreamHandlerContext;
}

function makeEvent(overrides: Partial<OpenPanelEvent> = {}): OpenPanelEvent {
  return {
    type: "open_panel",
    panelType: "channel_setup",
    data: { channel: "slack" },
    conversationId: "conv-1",
    surfaceId: "surf-1",
    ...overrides,
  };
}

beforeEach(() => {
  submitSurfaceActionCalls.length = 0;
});

describe("handleOpenPanel acknowledgment", () => {
  it("opens the channel setup drawer and acks", () => {
    handleOpenPanel(makeEvent(), makeCtx());

    expect(useViewerStore.getState().mainView).toBe("channel-setup");
    expect(useViewerStore.getState().activeChannelSetup?.channel).toBe("slack");
    expect(useViewerStore.getState().activeChannelSetup?.conversationId).toBe(
      "conv-1",
    );
    expect(submitSurfaceActionCalls).toEqual([
      {
        assistantId: "ast-1",
        surfaceId: "surf-1",
        actionId: "ack",
        data: undefined,
        conversationId: "conv-1",
      },
    ]);
  });

  it("nacks with a reason when the stream has no assistant", () => {
    handleOpenPanel(
      makeEvent({ surfaceId: "surf-2" }),
      makeCtx({ assistantId: null }),
    );

    expect(submitSurfaceActionCalls).toEqual([
      {
        assistantId: "ast-1",
        surfaceId: "surf-2",
        actionId: "nack",
        data: { reason: "no_active_assistant" },
        conversationId: "conv-1",
      },
    ]);
  });

  it("nacks unknown panel types instead of silently dropping them", () => {
    handleOpenPanel(
      makeEvent({ panelType: "not_a_real_panel", surfaceId: "surf-3" }),
      makeCtx(),
    );

    expect(submitSurfaceActionCalls).toEqual([
      {
        assistantId: "ast-1",
        surfaceId: "surf-3",
        actionId: "nack",
        data: { reason: "unknown_panel_type" },
        conversationId: "conv-1",
      },
    ]);
  });

  it("sends no ack for events without a surfaceId", () => {
    handleOpenPanel(makeEvent({ surfaceId: undefined }), makeCtx());

    expect(useViewerStore.getState().mainView).toBe("channel-setup");
    expect(submitSurfaceActionCalls).toHaveLength(0);
  });
});
