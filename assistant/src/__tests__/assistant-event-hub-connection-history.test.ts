import { beforeEach, describe, expect, mock, test } from "bun:test";

const recorded: Array<{
  clientId: string;
  reason: string;
  connectionId: string;
}> = [];

mock.module("../persistence/client-connection-events-store.js", () => ({
  recordClientConnectionEvent: (input: {
    clientId: string;
    reason: string;
    connectionId: string;
  }) => {
    recorded.push({
      clientId: input.clientId,
      reason: input.reason,
      connectionId: input.connectionId,
    });
    return null;
  },
}));

import { AssistantEventHub } from "../runtime/assistant-event-hub.js";

describe("AssistantEventHub connection history", () => {
  beforeEach(() => {
    recorded.length = 0;
  });

  test("records sse_open on client subscribe and sse_close on dispose", () => {
    const hub = new AssistantEventHub();
    const sub = hub.subscribe({
      type: "client",
      clientId: "client-123",
      interfaceId: "chrome-extension",
      capabilities: ["host_browser"],
      callback: () => {},
    });

    expect(recorded.map((row) => row.reason)).toEqual(["sse_open"]);
    sub.dispose();
    expect(recorded.map((row) => row.reason)).toEqual(["sse_open", "sse_close"]);
  });

  test("records stale_replaced then sse_open on reconnect", () => {
    const hub = new AssistantEventHub();
    hub.subscribe({
      type: "client",
      clientId: "client-123",
      interfaceId: "chrome-extension",
      capabilities: ["host_browser"],
      callback: () => {},
    });
    hub.subscribe({
      type: "client",
      clientId: "client-123",
      interfaceId: "chrome-extension",
      capabilities: ["host_browser"],
      callback: () => {},
    });

    expect(recorded.map((row) => row.reason)).toEqual([
      "sse_open",
      "stale_replaced",
      "sse_open",
    ]);
  });

  test("records force_disconnect from disposeClient", () => {
    const hub = new AssistantEventHub();
    hub.subscribe({
      type: "client",
      clientId: "client-123",
      interfaceId: "chrome-extension",
      capabilities: ["host_browser"],
      callback: () => {},
    });
    recorded.length = 0;

    expect(hub.disposeClient("client-123")).toBe(1);
    expect(recorded.map((row) => row.reason)).toEqual(["force_disconnect"]);
  });

  test("records cap_evicted when the oldest subscriber is shed", () => {
    const hub = new AssistantEventHub({ maxSubscribers: 1 });
    hub.subscribe({
      type: "client",
      clientId: "client-old",
      interfaceId: "web",
      capabilities: [],
      callback: () => {},
    });
    recorded.length = 0;

    hub.subscribe({
      type: "client",
      clientId: "client-new",
      interfaceId: "web",
      capabilities: [],
      callback: () => {},
    });

    expect(recorded.map((row) => row.reason)).toEqual([
      "cap_evicted",
      "sse_open",
    ]);
    expect(recorded[0].clientId).toBe("client-old");
  });

  test("does not record process subscribers", () => {
    const hub = new AssistantEventHub();
    const sub = hub.subscribe({
      type: "process",
      callback: () => {},
    });
    sub.dispose();
    expect(recorded).toEqual([]);
  });
});
