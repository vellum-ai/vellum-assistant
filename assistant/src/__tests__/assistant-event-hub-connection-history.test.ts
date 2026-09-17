import { beforeEach, describe, expect, test } from "bun:test";

import type { ClientConnectionEventInput } from "../persistence/client-connection-events-store.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";

describe("AssistantEventHub connection history", () => {
  const recorded: Array<Pick<ClientConnectionEventInput, "clientId" | "reason">> =
    [];

  beforeEach(() => {
    recorded.length = 0;
  });

  function hub(options?: { maxSubscribers?: number }): AssistantEventHub {
    return new AssistantEventHub({
      ...options,
      recordConnection: (input) => {
        recorded.push({ clientId: input.clientId, reason: input.reason });
        return null;
      },
    });
  }

  test("records sse_open on client subscribe and sse_close on dispose", () => {
    const sub = hub().subscribe({
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
    const instance = hub();
    instance.subscribe({
      type: "client",
      clientId: "client-123",
      interfaceId: "chrome-extension",
      capabilities: ["host_browser"],
      callback: () => {},
    });
    instance.subscribe({
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
    const instance = hub();
    instance.subscribe({
      type: "client",
      clientId: "client-123",
      interfaceId: "chrome-extension",
      capabilities: ["host_browser"],
      callback: () => {},
    });
    recorded.length = 0;

    expect(instance.disposeClient("client-123")).toBe(1);
    expect(recorded.map((row) => row.reason)).toEqual(["force_disconnect"]);
  });

  test("records cap_evicted when the oldest subscriber is shed", () => {
    const instance = hub({ maxSubscribers: 1 });
    instance.subscribe({
      type: "client",
      clientId: "client-old",
      interfaceId: "web",
      capabilities: [],
      callback: () => {},
    });
    recorded.length = 0;

    instance.subscribe({
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
    const sub = hub().subscribe({
      type: "process",
      callback: () => {},
    });
    sub.dispose();
    expect(recorded).toEqual([]);
  });
});
