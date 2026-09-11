import { afterEach, expect, mock, test } from "bun:test";

import type { CesClient } from "../../credential-execution/client.js";
import {
  _resetBackend,
  setCesClient,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { withMcpCredentialLock } from "../credential-coordination.js";

const originalSetTimeout = globalThis.setTimeout;
afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  _resetBackend();
});

test("MCP mutation lock remains held until CES persistence acknowledges completion", async () => {
  let entered!: () => void;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const pendingWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  setCesClient({
    isReady: () => true,
    call: mock(async () => {
      entered();
      await pendingWrite;
      return { ok: true };
    }),
  } as unknown as CesClient);
  let earlyDeadlineScheduled = false;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 45_000) {
      earlyDeadlineScheduled = true;
      queueMicrotask(() => callback(...args));
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;

  const write = withMcpCredentialLock("acknowledged-write", () =>
    setSecureKeyAsync("mcp:acknowledged-write:tokens", "example-token"),
  );
  await began;
  await expect(
    withMcpCredentialLock("acknowledged-write", async () => {}, 0),
  ).rejects.toThrow("storage is busy");
  expect(earlyDeadlineScheduled).toBe(false);
  release();
  expect(await write).toBe(true);
  await withMcpCredentialLock("acknowledged-write", async () => {}, 0);
});
