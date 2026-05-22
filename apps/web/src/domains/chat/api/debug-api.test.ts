import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import {
  installVellumDebugApi,
} from "@/domains/chat/api/debug-api.js";

describe("installVellumDebugApi", () => {
  beforeEach(() => {
    (window as unknown as { _vellumDebug?: unknown })._vellumDebug = undefined;
  });

  afterEach(() => {
    (window as unknown as { _vellumDebug?: unknown })._vellumDebug = undefined;
  });

  test("installs window._vellumDebug.events", () => {
    installVellumDebugApi();
    expect(window._vellumDebug).toBeDefined();
    expect(window._vellumDebug!.events).toBeDefined();
    expect(typeof window._vellumDebug!.events.getClients).toBe("function");
    expect(typeof window._vellumDebug!.events.getEvents).toBe("function");
  });

  test("is idempotent — does not overwrite existing events", () => {
    const customApi = { getClients: () => [{ id: "custom" } as never], getEvents: () => [] };
    (window as unknown as { _vellumDebug?: { events: typeof customApi } })._vellumDebug = { events: customApi };

    installVellumDebugApi();
    expect(window._vellumDebug!.events).toBe(customApi);
  });

  test("preserves other top-level keys when reinstalling", () => {
    (window as unknown as { _vellumDebug?: { other: { foo: string } } })._vellumDebug = { other: { foo: "bar" } };
    installVellumDebugApi();
    expect(
      (window._vellumDebug as unknown as { other: { foo: string } }).other,
    ).toEqual({ foo: "bar" });
    expect(window._vellumDebug!.events).toBeDefined();
  });
});
