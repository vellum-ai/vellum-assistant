import { describe, expect, mock, test } from "bun:test";

import type { CesClient } from "../credential-execution/client.js";
import {
  awaitCesClientWithTimeout,
  DEFAULT_CES_STARTUP_TIMEOUT_MS,
  injectCesClientWhenReady,
} from "../credential-execution/startup-timeout.js";

function makeResolver(initial?: CesClient) {
  let current = initial;
  const setCesClient = mock((client: CesClient) => {
    current = client;
  });
  return {
    getCesClient: () => current,
    setCesClient,
  };
}

/** Wait for the microtask attached to the resolved promise to run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("awaitCesClientWithTimeout", () => {
  test("clears the fallback timer when the CES client resolves first", async () => {
    const onTimeout = mock(() => {});
    const client = { isReady: () => true } as unknown as CesClient;

    const result = await awaitCesClientWithTimeout(Promise.resolve(client), {
      timeoutMs: 25,
      onTimeout,
    });

    expect(result).toBe(client);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onTimeout).not.toHaveBeenCalled();
  });

  test("returns undefined and runs the fallback handler when the timeout wins", async () => {
    const onTimeout = mock(() => {});

    const result = await awaitCesClientWithTimeout(new Promise(() => {}), {
      timeoutMs: 10,
      onTimeout,
    });

    expect(result).toBeUndefined();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test("exports the daemon CES startup timeout constant", () => {
    expect(DEFAULT_CES_STARTUP_TIMEOUT_MS).toBe(20_000);
  });
});

describe("injectCesClientWhenReady", () => {
  test("injects the client into an empty resolver once the handshake resolves", async () => {
    const client = { isReady: () => true } as unknown as CesClient;
    const resolver = makeResolver();

    injectCesClientWhenReady(Promise.resolve(client), resolver);
    await flush();

    expect(resolver.setCesClient).toHaveBeenCalledTimes(1);
    expect(resolver.getCesClient()).toBe(client);
  });

  test("does not overwrite a client installed by a reconnection", async () => {
    const reconnected = { isReady: () => true } as unknown as CesClient;
    const lateStartupClient = { isReady: () => true } as unknown as CesClient;
    const resolver = makeResolver(reconnected);

    injectCesClientWhenReady(Promise.resolve(lateStartupClient), resolver);
    await flush();

    expect(resolver.setCesClient).not.toHaveBeenCalled();
    expect(resolver.getCesClient()).toBe(reconnected);
  });

  test("is a no-op when the handshake resolves without a client", async () => {
    const resolver = makeResolver();

    injectCesClientWhenReady(Promise.resolve(undefined), resolver);
    await flush();

    expect(resolver.setCesClient).not.toHaveBeenCalled();
    expect(resolver.getCesClient()).toBeUndefined();
  });

  test("swallows a rejected handshake without injecting", async () => {
    const resolver = makeResolver();

    injectCesClientWhenReady(Promise.reject(new Error("aborted")), resolver);
    await flush();

    expect(resolver.setCesClient).not.toHaveBeenCalled();
    expect(resolver.getCesClient()).toBeUndefined();
  });
});
