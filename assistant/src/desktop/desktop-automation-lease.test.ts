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
  const notify = mock(async () => {});
  const lease = new DesktopAutomationLease({
    notify,
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
    notify,
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
  expect(f.lease.isActive).toBe(false);
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

test("activity follows the browser lease and clears before failed cleanup", async () => {
  const f = fixture();
  expect(f.lease.isActive).toBe(false);
  await f.lease.runBrowser(context, operation);
  expect(f.lease.isActive).toBe(true);
  expect(f.notify).toHaveBeenCalledTimes(1);
  await f.lease.runBrowser(context, operation);
  expect(f.notify).toHaveBeenCalledTimes(1);
  f.releaseBrowser.mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(f.lease.runBrowser(context, operation, true)).rejects.toThrow(
    "cleanup failed",
  );
  expect(f.lease.isActive).toBe(false);
  expect(f.notify).toHaveBeenCalledTimes(2);
  await f.lease.runBrowser(context, operation, true);
  expect(f.notify).toHaveBeenCalledTimes(2);
});

test("turn completion releases only its own desktop before cleanup finishes", async () => {
  const f = fixture();
  await f.lease.runBrowser(context, operation);
  f.lease.releaseForConversation("conv-456");
  expect(f.lease.isActive).toBe(true);
  expect(f.notify).toHaveBeenCalledTimes(1);

  const cleanup = Promise.withResolvers<void>();
  f.releaseBrowser.mockImplementationOnce(() => cleanup.promise);
  f.lease.releaseForConversation(context.conversationId);
  expect(f.lease.isActive).toBe(false);
  expect(f.notify).toHaveBeenCalledTimes(2);
  await Bun.sleep(0);
  expect(f.released).not.toHaveBeenCalled();

  const callback = mock(operation);
  const next = f.lease.runBrowser(context, callback);
  await Bun.sleep(0);
  expect(callback).not.toHaveBeenCalled();
  cleanup.resolve();
  expect((await next).isError).toBe(false);
  expect(f.released).toHaveBeenCalledTimes(1);
  expect(f.started).toHaveBeenCalledTimes(2);
  expect(f.lease.isActive).toBe(true);
});

test("turn completion cancels running and queued desktop work", async () => {
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
    .catch((error: unknown) => error);
  await started.promise;
  const callback = mock(operation);
  const queued = f.lease.runBrowser(context, callback);
  f.lease.releaseForConversation(context.conversationId);
  expect(f.lease.isActive).toBe(false);
  expect(await running).toBeInstanceOf(Error);
  expect((await queued).isError).toBe(true);
  expect(callback).not.toHaveBeenCalled();
  await f.lease.runBrowser(context, callback);
  expect(callback).toHaveBeenCalledTimes(1);
});

test("turn handoff retries failed cleanup without another turn or restart", async () => {
  const f = fixture();
  await f.lease.runBrowser(context, operation);
  f.releaseBrowser.mockRejectedValueOnce(new Error("Chrome cleanup timed out"));
  f.lease.releaseForConversation(context.conversationId);
  expect(f.lease.isActive).toBe(false);
  await Bun.sleep(0);
  expect(f.released).not.toHaveBeenCalled();
  await Bun.sleep(1_100);
  expect(f.released).toHaveBeenCalledTimes(1);
  const nextContext = { ...context, conversationId: "conv-456" };
  expect((await f.lease.runBrowser(nextContext, operation)).isError).toBe(
    false,
  );
  await f.lease.runBrowser(nextContext, operation, true);
});

test("a delayed cleanup retry cannot release a replacement owner", async () => {
  const f = fixture();
  await f.lease.runBrowser(context, operation);
  f.releaseBrowser.mockRejectedValueOnce(new Error("Chrome cleanup timed out"));
  f.lease.releaseForConversation(context.conversationId);
  await f.lease.runBrowser(context, operation, true);
  const nextContext = { ...context, conversationId: "conv-456" };
  await f.lease.runBrowser(nextContext, operation);
  await Bun.sleep(1_100);
  expect(f.lease.isActive).toBe(true);
  expect(f.released).toHaveBeenCalledTimes(1);
  await f.lease.runBrowser(nextContext, operation, true);
});

test("cleanup retries preserve commands queued behind an explicit handoff", async () => {
  const f = fixture();
  await f.lease.runBrowser(context, operation);
  f.releaseBrowser.mockRejectedValueOnce(new Error("Chrome cleanup timed out"));
  f.lease.releaseForConversation(context.conversationId);
  await Bun.sleep(0);
  const cleanup = Promise.withResolvers<void>();
  f.releaseBrowser.mockImplementationOnce(() => cleanup.promise);
  const detached = f.lease.runBrowser(context, operation, true);
  await Bun.sleep(0);
  const callback = mock(operation);
  const next = f.lease.runBrowser(context, callback);
  await Bun.sleep(1_100);
  cleanup.resolve();
  await detached;
  expect((await next).isError).toBe(false);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(f.lease.isActive).toBe(true);
});

test("turn completion cancels commands queued behind an in-progress detach", async () => {
  const f = fixture();
  await f.lease.runBrowser(context, operation);
  const cleanup = Promise.withResolvers<void>();
  f.releaseBrowser.mockImplementationOnce(() => cleanup.promise);
  const detached = f.lease.runBrowser(context, operation, true);
  await Bun.sleep(0);
  const callback = mock(operation);
  const queued = f.lease.runBrowser(context, callback);
  f.lease.releaseForConversation(context.conversationId);
  cleanup.resolve();
  await detached;
  expect((await queued).isError).toBe(true);
  expect(callback).not.toHaveBeenCalled();
  await f.lease.runBrowser(context, callback);
  expect(callback).toHaveBeenCalledTimes(1);
});

test("human help releases held input while reserving the desktop, then resumes its owner", async () => {
  const f = fixture();
  await f.lease.runBrowser(context, operation);
  const finish = await f.lease.reserveForHuman(context);
  expect(f.releaseBrowser).toHaveBeenCalledTimes(2);
  expect(f.released).not.toHaveBeenCalled();
  expect(f.lease.isActive).toBe(false);
  const callback = mock(operation);
  await expect(f.lease.runBrowser(context, callback)).rejects.toThrow(
    "reserved",
  );
  await expect(f.lease.runBrowser(context, callback, true)).rejects.toThrow(
    "reserved",
  );
  const other = { ...context, conversationId: "conv-456" };
  await expect(f.lease.runBrowser(other, callback)).rejects.toThrow(
    "Another conversation",
  );
  expect(callback).not.toHaveBeenCalled();
  await finish(true);
  expect(f.lease.isActive).toBe(true);
  await expect(f.lease.runBrowser(other, callback)).rejects.toThrow(
    "Another conversation",
  );
  await f.lease.runBrowser(context, callback);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(f.started).toHaveBeenCalledTimes(1);
});

test("closing human help releases its reservation and stale cleanup preserves the next owner", async () => {
  const f = fixture();
  const finish = await f.lease.reserveForHuman(context);
  await finish(false);
  expect(f.released).toHaveBeenCalledTimes(1);
  const other = { ...context, conversationId: "conv-456" };
  await f.lease.runBrowser(other, operation);
  await finish(false);
  expect(f.lease.isActive).toBe(true);
  expect(f.released).toHaveBeenCalledTimes(1);
  await f.lease.runBrowser(other, operation, true);
});

test("aborting human help releases its reservation", async () => {
  const f = fixture();
  const abort = new AbortController();
  const finish = await f.lease.reserveForHuman({
    ...context,
    signal: abort.signal,
  });
  abort.abort();
  await finish(true);
  expect(f.lease.isActive).toBe(false);
  expect(f.released).toHaveBeenCalledTimes(1);
  await f.lease.runBrowser(context, operation);
  expect(f.started).toHaveBeenCalledTimes(2);
});

test("the browser idle timeout cannot steal a pending human-help reservation", async () => {
  const f = fixture();
  const finish = await f.lease.reserveForHuman(context);
  const now = Date.now;
  const future = now() + 10 * 60_000;
  Date.now = () => future;
  try {
    await Bun.sleep(1_100);
    expect(f.released).not.toHaveBeenCalled();
    await expect(
      f.lease.runBrowser({ ...context, conversationId: "conv-456" }, operation),
    ).rejects.toThrow("Another conversation");
  } finally {
    Date.now = now;
    await finish(false);
  }
  expect(f.released).toHaveBeenCalledTimes(1);
});

test("ending human help retries failed input cleanup without another turn", async () => {
  const f = fixture();
  const finish = await f.lease.reserveForHuman(context);
  f.releaseBrowser.mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(finish(false)).rejects.toThrow("cleanup failed");
  await Bun.sleep(0);
  expect(f.released).toHaveBeenCalledTimes(1);
  await f.lease.runBrowser(context, operation);
  expect(f.lease.isActive).toBe(true);
});

for (const interrupt of ["browser", "handoff", "release", "cancel"] as const) {
  test(`${interrupt} invalidates native observations`, async () => {
    const f = fixture();
    const abort = new AbortController();
    const ownerContext = { ...context, signal: abort.signal };
    let id = "";
    await f.lease.runBrowser(ownerContext, async () => {
      id = f.lease.recordObservation();
      return operation();
    });
    if (interrupt === "browser") {
      await f.lease.runBrowser(ownerContext, operation);
    } else if (interrupt === "handoff") {
      const resume = await f.lease.reserveForHuman(ownerContext);
      await resume(true);
    } else if (interrupt === "release") {
      await f.lease.runBrowser(ownerContext, operation, true);
    } else {
      abort.abort();
    }
    const input = mock(operation);
    await expect(
      f.lease.runBrowser(context, input, false, { id }),
    ).rejects.toThrow("stale");
    expect(input).not.toHaveBeenCalled();
  });
}

test("queued actions cannot consume the same observation twice", async () => {
  const f = fixture();
  let id = "";
  await f.lease.runBrowser(context, async () => {
    id = f.lease.recordObservation();
    return operation();
  });
  const input = mock(operation);
  const actions = await Promise.allSettled([
    f.lease.runBrowser(context, input, false, { id }),
    f.lease.runBrowser(context, input, false, { id }),
  ]);
  expect(actions.map((action) => action.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(input).toHaveBeenCalledTimes(1);
});

test("a stale observation cannot start setup or reserve an unowned desktop", async () => {
  const f = fixture();
  const input = mock(operation);
  f.uninstall();
  await expect(
    f.lease.runBrowser(context, input, false, { id: "stale" }),
  ).rejects.toThrow("stale");
  expect(f.ensureReady).not.toHaveBeenCalled();
  expect(f.started).not.toHaveBeenCalled();
  expect(f.lease.isActive).toBe(false);
  expect(input).not.toHaveBeenCalled();
  f.completeSetup();
  await f.lease.runBrowser(
    { ...context, conversationId: "conv-456" },
    operation,
  );
  expect(f.started).toHaveBeenCalledTimes(1);
  await f.lease.runBrowser(
    { ...context, conversationId: "conv-456" },
    operation,
    true,
  );
});
