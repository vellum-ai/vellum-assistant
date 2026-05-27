import { describe, it, expect, beforeEach } from "bun:test";

import { useSSEConnectedStore, getSSEConnectedSnapshot } from "@/stores/sse-connected-store";

beforeEach(() => {
  useSSEConnectedStore.setState({ isConnected: false });
});

describe("useSSEConnectedStore", () => {
  it("initial state is false", () => {
    expect(useSSEConnectedStore.getState().isConnected).toBe(false);
    expect(getSSEConnectedSnapshot()).toBe(false);
  });

  it("setConnected(true) flips both hook and snapshot", () => {
    useSSEConnectedStore.getState().setConnected(true);
    expect(useSSEConnectedStore.getState().isConnected).toBe(true);
    expect(getSSEConnectedSnapshot()).toBe(true);
  });

  it("setConnected(false) flips back", () => {
    useSSEConnectedStore.getState().setConnected(true);
    useSSEConnectedStore.getState().setConnected(false);
    expect(getSSEConnectedSnapshot()).toBe(false);
  });
});
