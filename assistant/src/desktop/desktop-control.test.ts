import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../tools/types.js";
import { DesktopControl } from "./desktop-control.js";
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
  const manager = {
    acquireAutomationSlot: (owner: DesktopViewer) => {
      holder = owner;
      return { ok: true };
    },
    releaseAutomationSlot: released,
    ensureDesktopRunning: started,
  } as unknown as DesktopSessionManager;
  const control = new DesktopControl({
    enabled: () => enabled,
    ready: () => ready,
    manager: () => manager,
    input,
    notify: async () => {},
  });
  cleanups.push(() => control.takeControl());
  return {
    control,
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
      expect(f.started).not.toHaveBeenCalled();
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
    await f.control.takeControl();
    expect(await rejected).toBeInstanceOf(Error);
    expect((await queued).yieldToUser).toBe(true);
    expect(f.input.perform).toHaveBeenCalledTimes(1);
    expect(f.control.getStatus().state).toBe("human");
    expect(
      (await f.control.execute({ action: "observe" }, context())).yieldToUser,
    ).toBe(true);
    await f.control.allowAssistant();
    await observe(f.control);
    expect(f.started).toHaveBeenCalledTimes(2);
  });

  test("turn cancellation releases keys and the automation slot", async () => {
    const f = fixture();
    const abort = new AbortController();
    await observe(f.control, context(abort.signal));
    abort.abort();
    await f.control.allowAssistant();
    expect(f.released).toHaveBeenCalledTimes(1);
    expect(f.input.releaseInput).toHaveBeenCalledTimes(2);
  });

  test("desktop loss and a disabled flag release the active session", async () => {
    const f = fixture();
    await observe(f.control);
    f.lose();
    await f.control.allowAssistant();
    expect(f.released).toHaveBeenCalledTimes(1);
    await observe(f.control);
    f.disable();
    await expect(
      f.control.execute({ action: "observe" }, context()),
    ).rejects.toThrow("not available");
    expect(f.released).toHaveBeenCalledTimes(2);
  });
});

test.each(["releaseInput", "setViewerInput"] as const)(
  "a failed %s remains retryable before handing input back",
  async (operation) => {
    const f = fixture();
    await observe(f.control);
    f.input[operation].mockImplementationOnce(async () => {
      throw new Error("X server busy");
    });
    await expect(f.control.takeControl()).rejects.toThrow("X server busy");
    expect(f.control.getStatus().state).toBe("assistant");
    expect(
      (await f.control.execute({ action: "observe" }, context())).yieldToUser,
    ).toBe(true);
    await f.control.takeControl();
    expect(f.control.getStatus().state).toBe("human");
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
