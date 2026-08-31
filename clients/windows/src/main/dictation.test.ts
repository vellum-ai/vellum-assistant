import { beforeEach, expect, mock, test } from "bun:test";

const appListeners = new Map<string, () => void>();
mock.module("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "/repo/clients/windows",
    on: (event: string, listener: () => void) =>
      appListeners.set(event, listener),
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      rawListeners[channel] = listener;
    },
    removeAllListeners: (channel: string) => {
      delete rawListeners[channel];
    },
  },
}));

type Handler = (args: unknown[], event: { sender: FakeSender }) => unknown;
const handlers: Record<string, Handler> = {};
const rawListeners: Record<string, (...args: unknown[]) => void> = {};
mock.module("./ipc.client", () => ({
  handle: (channel: string, _schema: unknown, fn: Handler) => {
    handlers[channel] = fn;
  },
  on: (channel: string, _schema: unknown, fn: Handler) => {
    handlers[channel] = fn;
  },
}));
mock.module("./logger", () => ({
  default: { info: () => undefined, warn: () => undefined },
}));

class FakeClient {
  calls: Array<{ method: string; params?: unknown }> = [];
  notifications = new Map<string, (params: unknown) => void>();
  stateListener: ((state: unknown) => void) | null = null;
  results: Record<string, unknown> = {
    ping: "pong",
    "dictation.setPartials": { enabled: true, tap: "push" },
    "dictation.appendAudio": { ok: true },
    "dictation.transcribe": { ok: true },
  };

  call(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return Promise.resolve(this.results[method]);
  }
  onNotification(
    method: string,
    _schema: unknown,
    listener: (params: unknown) => void,
  ): () => void {
    this.notifications.set(method, listener);
    return () => undefined;
  }
  onState(listener: (state: unknown) => void): () => void {
    this.stateListener = listener;
    return () => undefined;
  }
  getState(): unknown {
    return { status: "running" };
  }
  retry(): unknown {
    return { status: "running" };
  }
  shutdown(): void {}
}
let fakeClient = new FakeClient();
mock.module("@vellumai/native-sidecar/supervisor", () => ({
  NativeSidecarClient: class {
    constructor() {
      return fakeClient as never;
    }
  },
}));

type FakeSender = {
  id: number;
  isDestroyed: () => boolean;
  send: ReturnType<typeof mock>;
};
let nextSenderId = 1;
const makeSender = (): FakeSender => ({
  id: nextSenderId++,
  isDestroyed: () => false,
  send: mock(() => undefined),
});

const { __resetForTesting, installDictation } =
  await import("./features/dictation");

beforeEach(() => {
  fakeClient = new FakeClient();
  __resetForTesting(() => fakeClient as never);
  for (const key of Object.keys(handlers)) {
    delete handlers[key];
  }
  appListeners.clear();
  installDictation();
});

test("dictation partials route to the owner and gate pushed audio", async () => {
  const owner = makeSender();
  const stranger = makeSender();
  const result = await handlers["vellum:helper:dictation:setPartials"]!(
    [true, undefined, true],
    { sender: owner },
  );
  expect(result).toEqual({ ok: true, enabled: true });
  expect(fakeClient.calls[0]).toEqual({
    method: "dictation.setPartials",
    params: { enable: true, pushAudio: true, sampleRate: 16000 },
  });

  fakeClient.notifications.get("dictation.partial")!({ text: "hello" });
  expect(owner.send).toHaveBeenCalledWith("vellum:helper:dictation:partial", {
    text: "hello",
  });
  expect(stranger.send).not.toHaveBeenCalled();

  handlers["vellum:helper:dictation:audio"]!(
    [new Uint8Array([1, 2]).buffer],
    { sender: stranger },
  );
  expect(
    fakeClient.calls.some((c) => c.method === "dictation.appendAudio"),
  ).toBe(false);
  handlers["vellum:helper:dictation:audio"]!(
    [new Uint8Array([1, 2]).buffer],
    { sender: owner },
  );
  expect(
    fakeClient.calls.some((c) => c.method === "dictation.appendAudio"),
  ).toBe(true);

  // The finalized transcript still routes after disable.
  await handlers["vellum:helper:dictation:setPartials"]!(
    [false, undefined, undefined],
    { sender: owner },
  );
  fakeClient.notifications.get("dictation.finalized")!({ text: "done" });
  expect(owner.send).toHaveBeenCalledWith("vellum:helper:dictation:finalized", {
    text: "done",
  });
});

test("a replaced owner cannot stop the active dictation", async () => {
  const replaced = makeSender();
  const active = makeSender();
  await handlers["vellum:helper:dictation:setPartials"]!(
    [true, undefined, true],
    { sender: replaced },
  );
  await handlers["vellum:helper:dictation:setPartials"]!(
    [true, undefined, true],
    { sender: active },
  );

  expect(replaced.send).toHaveBeenCalledWith(
    "vellum:helper:dictation:finalized",
    { text: "" },
  );
  expect(
    await handlers["vellum:helper:dictation:setPartials"]!(
      [false, undefined, undefined],
      { sender: replaced },
    ),
  ).toEqual({ ok: true, enabled: false });
  expect(fakeClient.calls).toHaveLength(2);

  fakeClient.notifications.get("dictation.partial")!({ text: "active" });
  expect(active.send).toHaveBeenCalledWith(
    "vellum:helper:dictation:partial",
    { text: "active" },
  );
});

test("a helper crash drops the session owners", async () => {
  const owner = makeSender();
  const transcribing = makeSender();
  await handlers["vellum:helper:dictation:setPartials"]!(
    [true, undefined, true],
    { sender: owner },
  );
  await handlers["vellum:helper:dictation:transcribe"]!(
    [new Uint8Array([1]).buffer],
    { sender: transcribing },
  );
  fakeClient.stateListener!({ status: "backing-off" });

  expect(owner.send).toHaveBeenCalledWith("vellum:helper:dictation:finalized", {
    text: "",
  });
  expect(transcribing.send).toHaveBeenCalledWith(
    "vellum:helper:dictation:transcribed",
    { text: "" },
  );
  owner.send.mockClear();

  fakeClient.notifications.get("dictation.partial")!({ text: "late" });
  fakeClient.notifications.get("dictation.finalized")!({ text: "late" });
  expect(owner.send).not.toHaveBeenCalled();

  handlers["vellum:helper:dictation:audio"]!(
    [new Uint8Array([1]).buffer],
    { sender: owner },
  );
  expect(
    fakeClient.calls.some((c) => c.method === "dictation.appendAudio"),
  ).toBe(false);
});

test("a terminal recognition error settles and clears the owner", async () => {
  const owner = makeSender();
  await handlers["vellum:helper:dictation:setPartials"]!(
    [true, undefined, true],
    { sender: owner },
  );

  fakeClient.notifications.get("dictation.error")!({ message: "failed" });
  expect(owner.send).toHaveBeenCalledWith("vellum:helper:dictation:finalized", {
    text: "",
  });

  fakeClient.notifications.get("dictation.partial")!({ text: "late" });
  expect(owner.send).toHaveBeenCalledTimes(1);
});

test("server-path retry keeps the streaming owner", async () => {
  const owner = makeSender();
  await handlers["vellum:helper:dictation:setPartials"]!(
    [true, undefined, false],
    { sender: owner },
  );

  fakeClient.notifications.get("dictation.error")!({
    message: "no output",
    onDevice: true,
    willRetryServer: true,
  });
  expect(owner.send).not.toHaveBeenCalled();

  fakeClient.notifications.get("dictation.partial")!({ text: "server" });
  expect(owner.send).toHaveBeenCalledWith(
    "vellum:helper:dictation:partial",
    { text: "server" },
  );
});

test("one-shot transcription routes independently from streaming", async () => {
  const recording = makeSender();
  const transcribing = makeSender();
  await handlers["vellum:helper:dictation:setPartials"]!(
    [true, undefined, true],
    { sender: recording },
  );

  expect(
    await handlers["vellum:helper:dictation:transcribe"]!(
      [new Uint8Array([1, 2]).buffer],
      { sender: transcribing },
    ),
  ).toEqual({ ok: true });
  expect(fakeClient.calls.at(-1)).toEqual({
    method: "dictation.transcribe",
    params: {
      audio: "AQI=",
      sampleRate: 16000,
      requestId: expect.any(String),
    },
  });
  const requestId = (fakeClient.calls.at(-1)?.params as { requestId: string })
    .requestId;

  fakeClient.notifications.get("dictation.partial")!({ text: "streaming" });
  fakeClient.notifications.get("dictation.error")!({ message: "device lost" });
  fakeClient.notifications.get("dictation.transcribed")!({
    requestId,
    text: "complete",
  });
  expect(recording.send).toHaveBeenCalledWith(
    "vellum:helper:dictation:partial",
    { text: "streaming" },
  );
  expect(transcribing.send).toHaveBeenCalledWith(
    "vellum:helper:dictation:transcribed",
    { text: "complete" },
  );
});

test("one-shot transcription settles replacements and drops stale completions", async () => {
  const replaced = makeSender();
  const active = makeSender();
  expect(
    await handlers["vellum:helper:dictation:transcribe"]!([new ArrayBuffer(0)], {
      sender: replaced,
    }),
  ).toEqual({ ok: false, reason: "empty audio" });

  let rejectFirst!: (reason: Error) => void;
  fakeClient.call = (method: string, params?: unknown): Promise<unknown> => {
    fakeClient.calls.push({ method, params });
    if (fakeClient.calls.filter((call) => call.method === method).length === 1) {
      return new Promise((_resolve, reject) => {
        rejectFirst = reject;
      });
    }
    return Promise.resolve({ ok: true });
  };
  const first = handlers["vellum:helper:dictation:transcribe"]!(
    [new Uint8Array([1]).buffer],
    { sender: replaced },
  ) as Promise<unknown>;
  await handlers["vellum:helper:dictation:transcribe"]!(
    [new Uint8Array([2]).buffer],
    { sender: active },
  );
  expect(replaced.send).toHaveBeenCalledWith(
    "vellum:helper:dictation:transcribed",
    { text: "" },
  );
  const transcriptionCalls = fakeClient.calls.filter(
    (call) => call.method === "dictation.transcribe",
  );
  const firstRequestId = (
    transcriptionCalls[0]!.params as { requestId: string }
  ).requestId;
  const activeRequestId = (
    transcriptionCalls[1]!.params as { requestId: string }
  ).requestId;

  fakeClient.notifications.get("dictation.transcribed")!({
    requestId: firstRequestId,
    text: "stale",
  });
  expect(active.send).not.toHaveBeenCalled();
  rejectFirst(new Error("replaced"));
  await first;

  fakeClient.notifications.get("dictation.transcribed")!({
    requestId: activeRequestId,
    text: "active",
  });
  expect(active.send).toHaveBeenCalledWith(
    "vellum:helper:dictation:transcribed",
    { text: "active" },
  );
  expect(replaced.send).toHaveBeenCalledTimes(1);
});
