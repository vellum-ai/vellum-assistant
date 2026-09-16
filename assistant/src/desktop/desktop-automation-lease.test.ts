import { afterEach, expect, mock, test } from "bun:test";

import { DesktopAutomationLease } from "./desktop-automation-lease.js";
import { DesktopDependencyInstaller } from "./desktop-dependencies.js";
import type { DesktopSessionManager } from "./desktop-session-manager.js";

const context = {
  conversationId: "conv-123",
  sourceActorPrincipalId: "user-123",
  trustClass: "guardian" as const,
  workingDir: "/tmp",
};
const cleanups: DesktopAutomationLease[] = [];
afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .map((lease) => lease.runBrowser(context, operation, true)),
  );
});
function fixture() {
  let enabled = true;
  let ready = true;
  const setup = Promise.withResolvers<void>();
  const install = mock(() => setup.promise);
  const installer = new DesktopDependencyInstaller({
    supported: () => true,
    ready: () => ready,
    install,
    notify: async () => {},
  });
  const ensureReady = mock((signal: AbortSignal) =>
    installer.ensureReady(signal),
  );
  const started = mock(async () => {});
  const released = mock(() => {});
  const releaseBrowser = mock(async () => {});
  const lease = new DesktopAutomationLease({
    enabled: () => enabled,
    ready: () => ready,
    ensureReady,
    manager: () =>
      ({
        browser: { release: releaseBrowser },
        acquireAutomationSlot: () => ({ ok: true }),
        releaseAutomationSlot: released,
        ensureDesktopRunning: started,
      }) as unknown as DesktopSessionManager,
  });
  cleanups.push(lease);
  return {
    lease,
    ensureReady,
    install,
    failSetup: () => setup.reject(new Error("download failed")),
    completeSetup: () => {
      ready = true;
      setup.resolve();
    },
    started,
    released,
    releaseBrowser,
    disable: () => {
      enabled = false;
    },
    uninstall: () => {
      ready = false;
    },
  };
}
const operation = async () => ({ content: "ok", isError: false });

test("browser session reuses one automation slot and isolates conversations", async () => {
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
});

for (const lose of ["disable", "uninstall"] as const) {
  test(`${lose} blocks startup, reuse and startup races`, async () => {
    const unavailable = fixture();
    unavailable[lose]();
    if (lose === "uninstall") {
      unavailable.ensureReady.mockRejectedValueOnce(new Error("setup failed"));
    }
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

test("cancellation stops running and queued browser commands without blocking a new session", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const abort = new AbortController();
  const running = f.lease
    .runBrowser({ ...context, signal: abort.signal }, async (signal) => {
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
  abort.abort();
  expect(await running).toBeInstanceOf(Error);
  expect((await queued).isError).toBe(true);
  expect(callback).not.toHaveBeenCalled();
  await f.lease.runBrowser(context, callback);
  expect(callback).toHaveBeenCalledTimes(1);
});

test("failed browser cleanup retains ownership until release succeeds", async () => {
  const f = fixture();
  await f.lease.runBrowser(context, operation);
  f.releaseBrowser.mockRejectedValueOnce(new Error("Chrome busy"));
  await expect(f.lease.runBrowser(context, operation, true)).rejects.toThrow(
    "Chrome busy",
  );
  expect(f.released).not.toHaveBeenCalled();
  await f.lease.runBrowser(context, operation, true);
  expect(f.released).toHaveBeenCalledTimes(1);
});

test("first browser call waits for one shared install then executes exactly once", async () => {
  const f = fixture();
  f.uninstall();
  const callback = mock(operation);
  const first = f.lease.runBrowser(context, callback);
  await Bun.sleep(0);
  expect(f.install).toHaveBeenCalledTimes(1);
  expect(f.started).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
  f.completeSetup();
  expect((await first).isError).toBe(false);
  expect(callback).toHaveBeenCalledTimes(1);
  await f.lease.runBrowser(context, callback);
  expect(f.install).toHaveBeenCalledTimes(1);
  expect(f.started).toHaveBeenCalledTimes(1);
});

for (const interrupt of ["cancel", "disable", "failure"] as const) {
  test(`${interrupt} during setup prevents a delayed browser action`, async () => {
    const f = fixture();
    f.uninstall();
    const abort = new AbortController();
    const callback = mock(operation);
    const result = f.lease
      .runBrowser({ ...context, signal: abort.signal }, callback)
      .catch((error: unknown) => error);
    await Bun.sleep(0);
    if (interrupt === "cancel") {
      abort.abort();
    } else if (interrupt === "disable") {
      f.disable();
    } else {
      f.failSetup();
    }
    expect(await result).toBeInstanceOf(Error);
    f.completeSetup();
    await Bun.sleep(0);
    expect(f.started).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
}

test("disabled, unidentified, cancelled and released browser calls cannot install", async () => {
  const f = fixture();
  f.uninstall();
  const cancelled = new AbortController();
  cancelled.abort();
  for (const caller of [
    { ...context, trustClass: "unknown" as const },
    { ...context, sourceActorPrincipalId: undefined },
    { ...context, signal: cancelled.signal },
  ]) {
    await expect(f.lease.runBrowser(caller, operation)).rejects.toThrow();
  }
  await f.lease.runBrowser(context, operation, true);
  f.disable();
  await expect(f.lease.runBrowser(context, operation)).rejects.toThrow();
  expect(f.ensureReady).not.toHaveBeenCalled();
});
