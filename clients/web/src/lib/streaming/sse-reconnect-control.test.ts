import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  clearSseReconnectHandler,
  requestSseReconnect,
  setSseReconnectHandler,
} from "@/lib/streaming/sse-reconnect-control";

describe("sse-reconnect-control", () => {
  beforeEach(() => {
    // Each test owns its own handler registration; install a throwaway
    // and immediately clear it so no handler leaks across tests.
    const noop = () => {};
    setSseReconnectHandler(noop);
    clearSseReconnectHandler(noop);
  });

  test("requestSseReconnect returns false when no handler is registered", () => {
    // GIVEN no connection owner has registered a reconnect handler

    // WHEN a reconnect is requested
    const serviced = requestSseReconnect(0);

    // THEN the request reports that nothing serviced it
    expect(serviced).toBe(false);
  });

  test("requestSseReconnect invokes the registered handler with the delay", () => {
    // GIVEN a registered reconnect handler
    const handler = mock((_delayMs: number) => {});
    setSseReconnectHandler(handler);

    // WHEN a reconnect is requested with a delay
    const serviced = requestSseReconnect(250);

    // THEN the handler runs with that delay and the request is serviced
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(250);
    expect(serviced).toBe(true);
  });

  test("requestSseReconnect defaults the delay to 0 and clamps negatives", () => {
    // GIVEN a registered reconnect handler
    const handler = mock((_delayMs: number) => {});
    setSseReconnectHandler(handler);

    // WHEN a reconnect is requested with no delay and then a negative one
    requestSseReconnect();
    requestSseReconnect(-100);

    // THEN both resolve to a non-negative 0 delay
    expect(handler).toHaveBeenNthCalledWith(1, 0);
    expect(handler).toHaveBeenNthCalledWith(2, 0);
  });

  test("clearSseReconnectHandler only clears when the handler still matches", () => {
    // GIVEN a first handler that is later superseded by a second
    const first = mock((_delayMs: number) => {});
    const second = mock((_delayMs: number) => {});
    setSseReconnectHandler(first);
    setSseReconnectHandler(second);

    // WHEN the stale first handler attempts to clear itself
    clearSseReconnectHandler(first);

    // THEN the newer handler is still active and services requests
    expect(requestSseReconnect(0)).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    // AND clearing the active handler leaves nothing registered
    clearSseReconnectHandler(second);
    expect(requestSseReconnect(0)).toBe(false);
  });
});
