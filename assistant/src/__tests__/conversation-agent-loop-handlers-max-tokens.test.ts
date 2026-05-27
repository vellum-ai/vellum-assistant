import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import {
  createEventHandlerState,
  type EventHandlerDeps,
  handleMaxTokensReached,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../daemon/message-protocol.js";

describe("max tokens reached handler", () => {
  test("emits and stores an inline continuation card", () => {
    const sent: ServerMessage[] = [];
    const ctx = {
      conversationId: "conv-1",
      surfaceState: new Map(),
      currentTurnSurfaces: [],
    };
    const deps = {
      ctx,
      onEvent: (msg: ServerMessage) => sent.push(msg),
      reqId: "req-1",
      isFirstMessage: false,
      shouldGenerateTitle: false,
      rlog: { warn: () => {} },
      turnChannelContext: {
        userMessageChannel: "vellum",
        assistantMessageChannel: "vellum",
      },
      turnInterfaceContext: {
        userMessageInterface: "web",
        assistantMessageInterface: "web",
      },
    } as unknown as EventHandlerDeps;

    handleMaxTokensReached(createEventHandlerState(), deps, {
      type: "max_tokens_reached",
      stopReason: "max_tokens",
    } as Extract<AgentEvent, { type: "max_tokens_reached" }>);

    const show = sent.find((msg) => msg.type === "ui_surface_show");
    expect(show).toBeDefined();
    if (!show || show.type !== "ui_surface_show") return;

    expect(show.surfaceType).toBe("card");
    expect((show.data as { title?: unknown }).title).toBe(
      "Response limit reached",
    );
    expect(show.actions?.[0]?.id).toBe("relay_prompt");
    expect(show.actions?.[0]?.data?.prompt).toContain("Continue");
    expect(show.actions?.[0]?.data?._completeSurface).toBe(true);
    expect(ctx.currentTurnSurfaces).toHaveLength(1);
    expect(ctx.surfaceState.has(show.surfaceId)).toBe(true);
  });
});
