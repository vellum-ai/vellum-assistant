import { expect, mock, test } from "bun:test";

const appListeners = new Map<string, () => void>();
mock.module("electron", () => ({
  app: {
    once: (event: string, listener: () => void) => {
      appListeners.set(event, listener);
    },
  },
}));

type Sender = {
  isDestroyed: () => boolean;
  send: ReturnType<typeof mock>;
};
const mainSender: Sender = {
  isDestroyed: () => false,
  send: mock(() => undefined),
};
const popoutSender: Sender = {
  isDestroyed: () => false,
  send: mock(() => undefined),
};
mock.module("./main-window", () => ({
  current: () => ({ webContents: mainSender }),
}));

let handler: ((args: unknown[], event: { sender: Sender }) => unknown) | null =
  null;
mock.module("./ipc.client", () => ({
  handle: (
    _channel: string,
    _schema: unknown,
    next: (args: unknown[], event: { sender: Sender }) => unknown,
  ) => {
    handler = next;
  },
}));
mock.module("./logger", () => ({
  default: { warn: () => undefined },
}));

class FakeHelper {
  calls: Array<{ method: string; params: unknown }> = [];
  stateListener: ((state: { status: string }) => void) | null = null;
  notificationListener: ((event: { state: "down" | "up" }) => void) | null =
    null;

  onNotification(
    _method: string,
    _schema: unknown,
    listener: (event: { state: "down" | "up" }) => void,
  ): void {
    this.notificationListener = listener;
  }
  onState(listener: (state: { status: string }) => void): void {
    this.stateListener = listener;
  }
  call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return Promise.resolve({ ok: true, enabled: true });
  }
  shutdown(): void {}
}
const helper = new FakeHelper();
mock.module("./windows-helper", () => ({
  getWindowsHelperClient: () => helper,
}));

const feature = (await import("./features/push-to-talk")).default;
feature.install({} as never);

test("restores the main window binding after a helper restart", async () => {
  const activator = { kind: "modifierOnly", modifiers: ["control"] };
  expect(
    await handler!([activator], { sender: mainSender }),
  ).toEqual({ ok: true, enabled: true });

  helper.notificationListener!({ state: "down" });
  helper.stateListener!({ status: "backing-off" });
  expect(mainSender.send).toHaveBeenLastCalledWith(
    "vellum:helper:hotkey:event",
    { kind: "pushToTalk", state: "up" },
  );

  helper.stateListener!({ status: "running" });
  await Promise.resolve();
  expect(helper.calls).toHaveLength(2);
  expect(helper.calls[1]).toEqual({
    method: "hotkey.setPushToTalk",
    params: { activator },
  });

  expect(await handler!([null], { sender: popoutSender })).toEqual({
    ok: false,
    reason: "Main window owns push-to-talk",
  });
  expect(helper.calls).toHaveLength(2);
});
