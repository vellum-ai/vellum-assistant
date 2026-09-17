import { afterEach, expect, test } from "bun:test";

import { setDbReady } from "../../daemon/daemon-readiness.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";
import { AssistantIpcServer } from "../assistant-server.js";
import { cliIpcCall } from "../cli-client.js";

let server: AssistantIpcServer | undefined;
afterEach(() => server?.stop());

for (const cancelOnDisconnect of [true, false]) {
  test(`timed-out IPC request cancels its action only when opted in: ${cancelOnDisconnect}`, async () => {
    setDbReady(true);
    server = new AssistantIpcServer();
    const methods = (
      server as unknown as {
        methods: Map<string, (args: RouteHandlerArgs) => Promise<unknown>>;
      }
    ).methods;
    const setup = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    let actions = 0;
    methods.set("test_browser_setup", async (args) => {
      signal = args.abortSignal;
      await setup.promise;
      if (!signal?.aborted) {
        actions++;
      }
      completed.resolve();
      return { ok: true };
    });
    await server.start();
    try {
      const result = await cliIpcCall(
        "test_browser_setup",
        {},
        {
          timeoutMs: 100,
          cancelOnDisconnect,
        },
      );
      expect(result.timedOut).toBe(true);
      expect(signal).toBeDefined();
      await Bun.sleep(20);
      setup.resolve();
      await completed.promise;
      expect(signal?.aborted).toBe(cancelOnDisconnect);
      expect(actions).toBe(cancelOnDisconnect ? 0 : 1);
    } finally {
      setup.resolve();
    }
  });
}
