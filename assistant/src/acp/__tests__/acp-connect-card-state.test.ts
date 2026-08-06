import { describe, expect, test } from "bun:test";

import {
  hasAcpConnectCardRaised,
  markAcpConnectCardRaised,
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
});
