import { afterEach, expect, mock, test } from "bun:test";

import { DesktopControlLease } from "./desktop-control-lease.js";
import type { DesktopSessionManager } from "./desktop-session-manager.js";

const context = {
  conversationId: "conv-123",
  sourceActorPrincipalId: "user-123",
  trustClass: "guardian" as const,
  workingDir: "/tmp",
};
const cleanups: DesktopControlLease[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((lease) => lease.takeControl()));
});
function fixture() {
  let enabled = true;
  let ready = true;
  const started = mock(async () => {});
  const released = mock(() => {});
  const releaseBrowser = mock(async () => {});
  const setViewerInput = mock(async (_enabled: boolean) => {});
  const lease = new DesktopControlLease({
    enabled: () => enabled,
    ready: () => ready,
    manager: () =>
      ({
        browser: { release: releaseBrowser },
        acquireAutomationSlot: () => ({ ok: true }),
        releaseAutomationSlot: released,
        ensureDesktopRunning: started,
      }) as unknown as DesktopSessionManager,
    input: { setViewerInput },
    notify: async () => {},
  });
  cleanups.push(lease);
  return {
    lease,
    started,
    released,
    releaseBrowser,
    setViewerInput,
    disable: () => {
      enabled = false;
    },
    uninstall: () => {
      ready = false;
    },
  };
}
const operation = async () => ({ content: "ok", isError: false });

test("browser-only ownership needs no native input or screenshot implementation", async () => {
  const f = fixture();
  await f.lease.runBrowser(context, operation);
  await f.lease.runBrowser(context, operation);
  expect(f.started).toHaveBeenCalledTimes(1);
  await expect(
    f.lease.runBrowser({ ...context, conversationId: "conv-456" }, operation),
  ).rejects.toThrow("Another conversation");
  expect(f.released).not.toHaveBeenCalled();
  await f.lease.runBrowser(context, operation, true);
  expect(f.released).toHaveBeenCalledTimes(1);
  expect(f.setViewerInput.mock.calls).toEqual([[false], [true]]);
});

for (const lose of ["disable", "uninstall"] as const) {
  test(`${lose} blocks startup, reuse and startup races`, async () => {
    const unavailable = fixture();
    unavailable[lose]();
    await expect(
      unavailable.lease.runBrowser(context, operation),
    ).rejects.toThrow();
    expect(unavailable.started).not.toHaveBeenCalled();
    const race = fixture();
    race.started.mockImplementationOnce(async () => race[lose]());
    const callback = mock(operation);
    await expect(race.lease.runBrowser(context, callback)).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(race.released).toHaveBeenCalledTimes(1);
    const reused = fixture();
    await reused.lease.runBrowser(context, operation);
    reused[lose]();
    await expect(reused.lease.runBrowser(context, callback)).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(reused.released).toHaveBeenCalledTimes(1);
  });
}

test("takeover cancels running and queued browser commands", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const running = f.lease
    .runBrowser(context, async (signal) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
      return operation();
    })
    .catch((error: Error) => error);
  await started.promise;
  const callback = mock(operation);
  const queued = f.lease.runBrowser(context, callback);
  await f.lease.takeControl();
  expect(await running).toBeInstanceOf(Error);
  expect((await queued).yieldToUser).toBe(true);
  expect(callback).not.toHaveBeenCalled();
  await f.lease.allowAssistant();
  await f.lease.runBrowser(context, callback);
  expect(callback).toHaveBeenCalledTimes(1);
});

test("failed browser cleanup retains ownership until release succeeds", async () => {
  const f = fixture();
  await f.lease.runBrowser(context, operation);
  f.releaseBrowser.mockRejectedValueOnce(new Error("Chrome busy"));
  await expect(f.lease.takeControl()).rejects.toThrow("Chrome busy");
  expect(f.released).not.toHaveBeenCalled();
  expect(f.lease.getStatus().state).toBe("assistant");
  await f.lease.takeControl();
  expect(f.released).toHaveBeenCalledTimes(1);
  expect(f.lease.getStatus().state).toBe("human");
});
