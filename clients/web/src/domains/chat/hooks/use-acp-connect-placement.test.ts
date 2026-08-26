/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Placement of the inline "Connect Claude Code" card.
 *
 * The card is anchored to the tool call that spawned the ACP run. While that
 * turn is still the last in the thread it renders inline, in the context that
 * explains it. Once the user has sent another message the anchor is history
 * and the card docks above the composer, where it stays reachable.
 */

import { describe, expect, test } from "bun:test";

import { decideAcpConnectPlacement } from "./use-acp-connect-placement";
import type { DisplayMessage } from "@/domains/chat/types/types";

function assistantWithTools(id: string, toolCallIds: string[]): DisplayMessage {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: toolCallIds.map((toolId) => ({ id: toolId, name: "acp_spawn" })),
  } as any;
}

function user(id: string): DisplayMessage {
  return { id, role: "user", content: "try again" } as any;
}

const ANCHOR = "chatcmpl-tool-anchor";

describe("decideAcpConnectPlacement", () => {
  test("no prompt up means no card anywhere", () => {
    expect(decideAcpConnectPlacement([assistantWithTools("a", [ANCHOR])], null))
      .toBeNull();
  });

  test("renders inline while the anchor's turn is the last one", () => {
    const messages = [user("u1"), assistantWithTools("a1", [ANCHOR])];
    expect(decideAcpConnectPlacement(messages, ANCHOR)).toBe("inline");
  });

  test("stays inline when the anchor's own turn continues", () => {
    // The assistant kept working after the spawn call; no new user turn, so
    // the anchor is still on screen.
    const messages = [
      user("u1"),
      assistantWithTools("a1", [ANCHOR]),
      assistantWithTools("a2", ["chatcmpl-tool-other"]),
    ];
    expect(decideAcpConnectPlacement(messages, ANCHOR)).toBe("inline");
  });

  test("docks once the user has sent another message", () => {
    const messages = [
      user("u1"),
      assistantWithTools("a1", [ANCHOR]),
      user("u2"),
      assistantWithTools("a2", ["chatcmpl-tool-other"]),
    ];
    expect(decideAcpConnectPlacement(messages, ANCHOR)).toBe("docked");
  });

  test("renders nowhere when the anchor is absent from this transcript", () => {
    // The prompt outlives a conversation switch, so an anchor that is not here
    // is most likely another conversation's. Docking it would show the card,
    // and its Connect button, against the assistant the user navigated to.
    const messages = [user("u9"), assistantWithTools("a9", ["unrelated"])];
    expect(decideAcpConnectPlacement(messages, ANCHOR)).toBeNull();
  });

  test("renders nowhere on an empty transcript", () => {
    expect(decideAcpConnectPlacement([], ANCHOR)).toBeNull();
  });

  test("matches the newest anchor when a run is respawned under one id", () => {
    const messages = [
      assistantWithTools("a1", [ANCHOR]),
      user("u2"),
      assistantWithTools("a2", [ANCHOR]),
    ];
    expect(decideAcpConnectPlacement(messages, ANCHOR)).toBe("inline");
  });
});
