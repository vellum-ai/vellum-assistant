import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../tools/types.js";
import { DesktopControl } from "./desktop-control.js";
import { DesktopControlLease } from "./desktop-control-lease.js";
import type { DesktopInput } from "./desktop-input.js";
import type {
  DesktopSessionManager,
  DesktopViewer,
} from "./desktop-session-manager.js";

const context = (signal?: AbortSignal): ToolContext => ({
  conversationId: "conversation-123",
  sourceActorPrincipalId: "user-123",
  trustClass: "guardian",
  workingDir: "/tmp",
  signal,
});
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

function fixture() {
  let enabled = true;
  let ready = true;
  let holder: DesktopViewer | null = null;
  const released = mock(() => {
    holder = null;
  });
  const started = mock(async () => {});
  const input = {
    observe: mock(async () => ({
      png: Buffer.from("screenshot"),
      width: 1440,
      height: 900,
    })),
    perform: mock<DesktopInput["perform"]>(async () => {}),
    releaseInput: mock(async () => {}),
    setViewerInput: mock(async (_enabled: boolean) => {}),
  };
  const browserRelease = mock(async () => {});
  const manager = {
    browser: { release: browserRelease },
    acquireAutomationSlot: (owner: DesktopViewer) => {
      holder = owner;
      return { ok: true };
    },
    releaseAutomationSlot: released,
    ensureDesktopRunning: started,
  } as unknown as DesktopSessionManager;
  const lease = new DesktopControlLease({
    enabled: () => enabled,
    ready: () => ready,
    manager: () => manager,
    input,
    notify: async () => {},
  });
  const control = new DesktopControl(lease, input, browserRelease);
  cleanups.push(() => lease.takeControl());
  return {
    control,
    lease,
    browserRelease,
    input,
    started,
    released,
    disable: () => {
      enabled = false;
    },
    uninstall: () => {
      ready = false;
    },
    lose: () =>
      holder?.onDesktopLost({ code: 4011, reason: "Desktop stopped" }),
  };
}

async function observe(control: DesktopControl, ctx = context()) {
  const result = await control.execute({ action: "observe" }, ctx);
  expect(result.contentBlocks?.[0]?.type).toBe("image");
  return result.content.match(/observation_id: ([a-f0-9-]+)/)![1]!;
}

describe("assistant desktop control", () => {
  test("observes and acts on one session, returning a fresh image after every action", async () => {
    const f = fixture();
    const id = await observe(f.control);
    const result = await f.control.execute(
      { action: "click", observation_id: id, x: 100, y: 50 },
      context(),
    );
    expect(f.started).toHaveBeenCalledTimes(1);
    expect(f.input.perform).toHaveBeenCalledTimes(1);
    expect(result.content).not.toContain(id);
    expect(f.input.observe).toHaveBeenCalledTimes(2);
    await f.control.execute({ action: "done" }, context());
    expect(f.released).toHaveBeenCalledTimes(1);
    expect(f.input.setViewerInput.mock.calls.map((args) => args[0])).toEqual([
      false,
      true,
    ]);
  });

  test("rejects a replayed observation without sending more input", async () => {
    const f = fixture();
    const id = await observe(f.control);
    await f.control.execute(
      { action: "key", key: "Return", observation_id: id },
      context(),
    );
    await expect(
      f.control.execute(
        { action: "key", key: "Return", observation_id: id },
        context(),
      ),
    ).rejects.toThrow("Stale");
    expect(f.input.perform).toHaveBeenCalledTimes(1);
    expect(f.released).toHaveBeenCalledTimes(1);
  });

  test("rejects other conversations and actors without releasing the owner", async () => {
    const f = fixture();
    await observe(f.control);
    for (const ctx of [
      { ...context(), conversationId: "conversation-456" },
      { ...context(), sourceActorPrincipalId: "user-456" },
    ]) {
      await expect(f.control.execute({ action: "done" }, ctx)).rejects.toThrow(
        "Another conversation",
      );
    }
    expect(f.released).not.toHaveBeenCalled();
  });

  test("disabled, uninstalled, unidentified, non-guardian and cancelled calls cannot start a desktop", async () => {
    for (const mode of [
      "disabled",
      "uninstalled",
      "unidentified",
      "non-guardian",
      "cancelled",
    ] as const) {
      const f = fixture();
      const ctx = context();
      if (mode === "disabled") {
        f.disable();
      }
      if (mode === "uninstalled") {
        f.uninstall();
      }
      if (mode === "unidentified") {
        ctx.sourceActorPrincipalId = undefined;
      }
      if (mode === "non-guardian") {
        ctx.trustClass = "unknown";
      }
      if (mode === "cancelled") {
        ctx.signal = AbortSignal.abort();
      }
      await expect(
        f.control.execute({ action: "observe" }, ctx),
      ).rejects.toBeDefined();
      const operation = mock(async () => ({ content: "ok", isError: false }));
      await expect(f.lease.runBrowser(ctx, operation)).rejects.toBeDefined();
      expect(f.started).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      expect(f.input.setViewerInput).not.toHaveBeenCalled();
    }
  });

  test("takeover aborts an in-flight action and rejects queued input until explicitly allowed", async () => {
    const f = fixture();
    const id = await observe(f.control);
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.input.perform.mockImplementation(async (_action, signal) => {
      started();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    });
    const action = f.control.execute(
      { action: "type", text: "hello", observation_id: id },
      context(),
    );
    const rejected = action.catch((err: Error) => err);
    await active;
    const queued = f.control.execute(
      { action: "key", key: "Return", observation_id: id },
      context(),
    );
    await f.lease.takeControl();
    expect(await rejected).toBeInstanceOf(Error);
    expect((await queued).yieldToUser).toBe(true);
    expect(f.input.perform).toHaveBeenCalledTimes(1);
    expect(f.lease.getStatus().state).toBe("human");
    expect(
      (await f.control.execute({ action: "observe" }, context())).yieldToUser,
    ).toBe(true);
    await f.lease.allowAssistant();
    await observe(f.control);
    expect(f.started).toHaveBeenCalledTimes(2);
  });

  test("turn cancellation releases keys and the automation slot", async () => {
    const f = fixture();
    const abort = new AbortController();
    await observe(f.control, context(abort.signal));
    abort.abort();
    await f.lease.allowAssistant();
    expect(f.released).toHaveBeenCalledTimes(1);
    expect(f.input.releaseInput).toHaveBeenCalledTimes(2);
  });

  test("desktop loss and a disabled flag release the active session", async () => {
    const f = fixture();
    await observe(f.control);
    f.lose();
    await f.lease.allowAssistant();
    expect(f.released).toHaveBeenCalledTimes(1);
    await observe(f.control);
    f.disable();
    await expect(
      f.control.execute({ action: "observe" }, context()),
    ).rejects.toThrow("not available");
    expect(f.released).toHaveBeenCalledTimes(2);
  });
});

describe.each(["disable", "uninstall"] as const)(
  "availability loss: %s",
  (lose) => {
    test("rejects browser use when availability changes during startup", async () => {
      const f = fixture();
      f.started.mockImplementationOnce(async () => f[lose]());
      const operation = mock(async () => ({ content: "ok", isError: false }));
      await expect(f.lease.runBrowser(context(), operation)).rejects.toThrow();
      expect(operation).not.toHaveBeenCalled();
      expect(f.input.observe).not.toHaveBeenCalled();
      expect(f.input.setViewerInput.mock.calls).not.toContainEqual([false]);
      expect(f.released).toHaveBeenCalledTimes(1);
    });

    test("releases a retained browser lease before rejecting another command", async () => {
      const f = fixture();
      const operation = mock(async () => ({ content: "ok", isError: false }));
      await f.lease.runBrowser(context(), operation);
      f[lose]();
      await expect(f.lease.runBrowser(context(), operation)).rejects.toThrow();
      expect(operation).toHaveBeenCalledTimes(1);
      expect(f.released).toHaveBeenCalledTimes(1);
      expect(f.input.setViewerInput.mock.calls.at(-1)).toEqual([true]);
      expect(f.lease.getStatus().state).toBe("idle");
    });

    test("cancels an in-flight browser operation and releases control", async () => {
      const f = fixture();
      const started = Promise.withResolvers<void>();
      const operation = f.lease.runBrowser(context(), async (signal) => {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return { content: "unexpected", isError: false };
      });
      const rejected = operation.catch((error: Error) => error);
      await started.promise;
      f[lose]();
      expect(await rejected).toBeInstanceOf(Error);
      expect(f.released).toHaveBeenCalledTimes(1);
      expect(f.lease.getStatus().state).toBe("idle");
    });
  },
);

test.each(["releaseInput", "setViewerInput"] as const)(
  "a failed %s remains retryable before handing input back",
  async (operation) => {
    const f = fixture();
    await observe(f.control);
    f.input[operation].mockImplementationOnce(async () => {
      throw new Error("X server busy");
    });
    await expect(f.lease.takeControl()).rejects.toThrow("X server busy");
    expect(f.lease.getStatus().state).toBe("assistant");
    expect(
      (await f.control.execute({ action: "observe" }, context())).yieldToUser,
    ).toBe(true);
    await f.lease.takeControl();
    expect(f.lease.getStatus().state).toBe("human");
    expect(f.released).toHaveBeenCalledTimes(1);
  },
);

test("rejects clicks and drag destinations outside the observed image before sending input", async () => {
  for (const action of [
    { action: "click", x: 1440, y: 50 },
    { action: "drag", x: 100, y: 50, to_x: 1600, to_y: 50 },
  ]) {
    const f = fixture();
    const id = await observe(f.control);
    await expect(
      f.control.execute({ ...action, observation_id: id }, context()),
    ).rejects.toThrow("inside the observed screenshot");
    expect(f.input.perform).not.toHaveBeenCalled();
    expect(f.released).toHaveBeenCalledTimes(1);
  }
});

test("browser commands share ownership and invalidate X11 observations", async () => {
  const f = fixture();
  const id = await observe(f.control);
  const operation = mock(async () => ({ content: "clicked", isError: false }));
  await expect(
    f.lease.runBrowser(
      { ...context(), conversationId: "conv-other" },
      operation,
    ),
  ).rejects.toThrow("Another conversation");
  expect(operation).not.toHaveBeenCalled();
  await f.lease.runBrowser(context(), operation);
  expect(f.started).toHaveBeenCalledTimes(1);
  await expect(
    f.control.execute(
      { action: "click", observation_id: id, x: 10, y: 10 },
      context(),
    ),
  ).rejects.toThrow("Stale");
  expect(f.input.perform).not.toHaveBeenCalled();
});

test("takeover cancels active and queued browser commands", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const running = f.lease
    .runBrowser(context(), async (signal) => {
      started.resolve();
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
      return { content: "unexpected", isError: false };
    })
    .catch((error: Error) => error);
  await started.promise;
  const operation = mock(async () => ({
    content: "unexpected",
    isError: false,
  }));
  const queued = f.lease.runBrowser(context(), operation);
  await f.lease.takeControl();
  expect(await running).toBeInstanceOf(Error);
  expect((await queued).yieldToUser).toBe(true);
  expect(operation).not.toHaveBeenCalled();
  expect(f.lease.getStatus().state).toBe("human");
  await f.lease.allowAssistant();
  await f.lease.runBrowser(context(), operation);
  expect(operation).toHaveBeenCalledTimes(1);
});

test("browser cleanup failure keeps its slot and still releases X11 input", async () => {
  const f = fixture();
  await observe(f.control);
  await f.lease.runBrowser(context(), async () => ({
    content: "ok",
    isError: false,
  }));
  f.browserRelease.mockRejectedValueOnce(new Error("Chrome busy"));
  await expect(f.lease.takeControl()).rejects.toThrow("Chrome busy");
  expect(f.released).not.toHaveBeenCalled();
  expect(f.input.releaseInput).toHaveBeenCalledTimes(2);
  expect(f.lease.getStatus().state).toBe("assistant");
  await f.lease.takeControl();
  expect(f.released).toHaveBeenCalledTimes(1);
  expect(f.lease.getStatus().state).toBe("human");
});

test("desktop loss clears a failed cleanup lease so the next session can restart", async () => {
  const f = fixture();
  await observe(f.control);
  await f.lease.runBrowser(context(), async () => ({
    content: "ok",
    isError: false,
  }));
  f.input.releaseInput.mockRejectedValueOnce(new Error("X server unavailable"));
  await expect(f.lease.takeControl()).rejects.toThrow("X server unavailable");
  f.lose();
  await f.lease.allowAssistant();
  expect(f.lease.getStatus().state).toBe("idle");
  await observe(f.control);
  expect(f.started).toHaveBeenCalledTimes(2);
});

test.each(["browser", "desktop"] as const)(
  "a reused %s lease follows the current turn's cancellation",
  async (mode) => {
    const f = fixture();
    const first = new AbortController();
    const second = new AbortController();
    const run = (signal: AbortSignal) =>
      mode === "browser"
        ? f.lease.runBrowser(context(signal), async () => ({
            content: "ok",
            isError: false,
          }))
        : f.control.execute({ action: "observe" }, context(signal));
    await run(first.signal);
    await run(second.signal);
    first.abort();
    await f.lease.allowAssistant();
    expect(f.lease.getStatus().state).toBe("assistant");
    expect(f.released).not.toHaveBeenCalled();
    second.abort();
    await f.lease.allowAssistant();
    expect(f.lease.getStatus().state).toBe("idle");
    expect(f.released).toHaveBeenCalledTimes(1);
    expect(f.input.setViewerInput.mock.calls.at(-1)).toEqual([true]);
  },
);

test("malformed actions release only the caller's lease without starting a desktop", async () => {
  const f = fixture();
  await expect(
    f.control.execute({ action: "click" }, context()),
  ).rejects.toThrow();
  expect(f.started).not.toHaveBeenCalled();
  const id = await observe(f.control);
  await expect(
    f.control.execute(
      { action: "click", observation_id: id, x: 100 },
      { ...context(), sourceActorPrincipalId: "user-456" },
    ),
  ).rejects.toThrow("Another conversation");
  expect(f.lease.getStatus().state).toBe("assistant");
  await expect(
    f.control.execute(
      { action: "click", observation_id: id, x: 100 },
      context(),
    ),
  ).rejects.toThrow();
  expect(f.input.perform).not.toHaveBeenCalled();
  expect(f.lease.getStatus().state).toBe("idle");
  expect(f.input.setViewerInput.mock.calls.at(-1)).toEqual([true]);
});
