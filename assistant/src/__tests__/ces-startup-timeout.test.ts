import { describe, expect, mock, test } from "bun:test";

import type { CesClient } from "../credential-execution/client.js";
import {
  awaitCesClientWithTimeout,
  DEFAULT_CES_STARTUP_TIMEOUT_MS,
} from "../credential-execution/startup-timeout.js";

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
