import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { PluginListenerHandle } from "@capacitor/core";

let isNative = true;
const isNativePlatformMock = mock(() => isNative);
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: isNativePlatformMock,
}));

const captureErrorMock = mock(() => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

const { subscribeCapacitorListener } =
  await import("@/runtime/capacitor-listener");

const handleRemoveMock = mock(async () => {});
let subscribeResolver: ((handle: PluginListenerHandle) => void) | null = null;
let subscribeRejecter: ((err: Error) => void) | null = null;

const subscribeMock = mock(
  () =>
    new Promise<PluginListenerHandle>((resolve, reject) => {
      subscribeResolver = resolve;
      subscribeRejecter = reject;
    }),
);

const flushMicrotasks = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  isNative = true;
  subscribeResolver = null;
  subscribeRejecter = null;
  isNativePlatformMock.mockClear();
  subscribeMock.mockClear();
  handleRemoveMock.mockClear();
  captureErrorMock.mockClear();
});

describe("subscribeCapacitorListener", () => {
  test("is a no-op off Capacitor iOS (returns a no-op unsubscribe, never calls subscribe)", () => {
    isNative = false;

    const unsubscribe = subscribeCapacitorListener("ctx", subscribeMock);
    unsubscribe();

    expect(subscribeMock).not.toHaveBeenCalled();
  });

  test("returned unsubscribe removes the listener once subscribe resolves", async () => {
    const unsubscribe = subscribeCapacitorListener("ctx", subscribeMock);

    subscribeResolver?.({ remove: handleRemoveMock });
    await flushMicrotasks();
    expect(handleRemoveMock).not.toHaveBeenCalled();

    unsubscribe();
    expect(handleRemoveMock).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe BEFORE subscribe resolves still removes the just-registered listener", async () => {
    const unsubscribe = subscribeCapacitorListener("ctx", subscribeMock);

    // Unsubscribe first — the internal `cancelled` flag must catch the
    // late resolution and remove the listener.
    unsubscribe();
    subscribeResolver?.({ remove: handleRemoveMock });
    await flushMicrotasks();

    expect(handleRemoveMock).toHaveBeenCalledTimes(1);
  });

  test("reports a subscribe failure under the given context instead of throwing", async () => {
    subscribeCapacitorListener("my_context", subscribeMock);

    const err = new Error("plugin missing");
    subscribeRejecter?.(err);
    await flushMicrotasks();

    expect(captureErrorMock).toHaveBeenCalledWith(err, {
      context: "my_context",
      level: "warning",
    });
  });
});
