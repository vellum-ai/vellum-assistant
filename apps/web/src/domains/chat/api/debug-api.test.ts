import { describe, expect, test } from "bun:test";

import { eventsDebugApi } from "@/domains/chat/api/debug-api";

describe("eventsDebugApi", () => {
  test("exposes getClients and getEvents callable accessors", () => {
    expect(typeof eventsDebugApi.getClients).toBe("function");
    expect(typeof eventsDebugApi.getEvents).toBe("function");
    expect(Array.isArray(eventsDebugApi.getClients())).toBe(true);
    expect(Array.isArray(eventsDebugApi.getEvents())).toBe(true);
  });
});
