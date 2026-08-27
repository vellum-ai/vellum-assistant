import { describe, expect, test } from "bun:test";

import {
  hasAcpConnectCardRaised,
  markAcpConnectCardRaised,
  takeConversationsWithAcpConnectCard,
} from "../acp-connect-card-state.js";

describe("acp-connect-card-state", () => {
  test("reports a raised card only for the conversation it was marked on", () => {
    // Unique ids keep this isolated from the process-wide (never-cleared) set.
    expect(hasAcpConnectCardRaised("conv-state-a")).toBe(false);

    markAcpConnectCardRaised("conv-state-a");

    expect(hasAcpConnectCardRaised("conv-state-a")).toBe(true);
    expect(hasAcpConnectCardRaised("conv-state-b")).toBe(false);
  });

  test("ignores an empty conversation id", () => {
    markAcpConnectCardRaised("");
    expect(hasAcpConnectCardRaised("")).toBe(false);
  });

  test("take hands back every raised conversation and forgets them", () => {
    // A new token retires these conversations' persisted markers, so an entry
    // left behind would keep redirecting the fallback at a card nothing can
    // re-raise.
    markAcpConnectCardRaised("conv-take-a");
    markAcpConnectCardRaised("conv-take-b");

    const taken = takeConversationsWithAcpConnectCard();

    expect(taken).toContain("conv-take-a");
    expect(taken).toContain("conv-take-b");
    expect(hasAcpConnectCardRaised("conv-take-a")).toBe(false);
    expect(hasAcpConnectCardRaised("conv-take-b")).toBe(false);
    expect(takeConversationsWithAcpConnectCard()).toEqual([]);
  });
});
