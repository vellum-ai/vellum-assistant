import { expect, mock, test } from "bun:test";
import type { IpcRenderer } from "electron";

import type {
  DownloadDoneEvent,
  WindowAttentionPayload,
} from "@vellumai/ipc-contract";
import { WINDOW_ATTENTION } from "@vellumai/ipc-contract";

import {
  createBundleConfirmBridge,
  createDownloadsBridge,
  createWindowAttentionSubscriber,
} from "./preload";

test("creates the bundle confirmation IPC bridge", async () => {
  const invoke = mock(() => Promise.resolve(null));
  const send = mock(() => undefined);
  const ipc = {
    invoke,
    send,
    on: mock(() => undefined),
    off: mock(() => undefined),
  } as unknown as Pick<IpcRenderer, "invoke" | "off" | "on" | "send">;
  const bridge = createBundleConfirmBridge(ipc);

  await bridge.getData();
  bridge.respond(true);

  expect(invoke).toHaveBeenCalledWith("vellum:bundleConfirm:getData");
  expect(send).toHaveBeenCalledWith("vellum:bundleConfirm:respond", true);
});

test("creates the downloads IPC bridge", async () => {
  type DoneHandler = (event: unknown, payload: DownloadDoneEvent) => void;
  let handler: DoneHandler | null = null;
  const invoke = mock(() => Promise.resolve());
  const on = mock((_channel: string, h: DoneHandler) => {
    handler = h;
  });
  const off = mock(() => undefined);
  const ipc = {
    invoke,
    send: mock(() => undefined),
    on,
    off,
  } as unknown as Pick<IpcRenderer, "invoke" | "off" | "on" | "send">;
  const bridge = createDownloadsBridge(ipc);

  const received: DownloadDoneEvent[] = [];
  const unsubscribe = bridge.onDone((event) => received.push(event));
  await bridge.reveal("dl-1");

  expect(invoke).toHaveBeenCalledWith("vellum:downloads:reveal", "dl-1");
  expect(on).toHaveBeenCalledWith(
    "vellum:downloads:done",
    expect.any(Function),
  );
  handler!({}, { id: "dl-1", filename: "report.pdf", state: "completed" });
  expect(received).toEqual([
    { id: "dl-1", filename: "report.pdf", state: "completed" },
  ]);

  unsubscribe();
  expect(off).toHaveBeenCalledWith("vellum:downloads:done", handler);
});

type AttentionHandler = (
  event: unknown,
  payload: WindowAttentionPayload,
) => void;

const attentionIpc = () => {
  let handler: AttentionHandler | null = null;
  const on = mock((_channel: string, h: AttentionHandler) => {
    handler = h;
  });
  const ipc = {
    invoke: mock(() => Promise.resolve()),
    send: mock(() => undefined),
    on,
    off: mock(() => undefined),
  } as unknown as Pick<IpcRenderer, "invoke" | "off" | "on" | "send">;
  return {
    broadcast: (payload: WindowAttentionPayload): void => {
      handler!({}, payload);
    },
    ipc,
    on,
  };
};

const ATTENDED: WindowAttentionPayload = {
  visible: true,
  focused: true,
  minimized: false,
};

const UNFOCUSED: WindowAttentionPayload = {
  visible: true,
  focused: false,
  minimized: false,
};

test("delivers broadcasts to a subscriber registered before the first one", () => {
  const { broadcast, ipc, on } = attentionIpc();
  const onWindowAttention = createWindowAttentionSubscriber(ipc);

  const received: WindowAttentionPayload[] = [];
  onWindowAttention((payload) => received.push(payload));

  expect(on).toHaveBeenCalledWith(WINDOW_ATTENTION, expect.any(Function));
  expect(received).toEqual([]);

  broadcast(UNFOCUSED);

  expect(received).toEqual([UNFOCUSED]);
});

test("replays the last window-attention payload to a late subscriber", () => {
  const { broadcast, ipc } = attentionIpc();
  const onWindowAttention = createWindowAttentionSubscriber(ipc);

  broadcast(ATTENDED);

  const received: WindowAttentionPayload[] = [];
  onWindowAttention((payload) => received.push(payload));

  expect(received).toEqual([ATTENDED]);
});

test("replays the window-attention payload to every late subscriber", () => {
  const { broadcast, ipc } = attentionIpc();
  const onWindowAttention = createWindowAttentionSubscriber(ipc);

  broadcast(ATTENDED);

  const first: WindowAttentionPayload[] = [];
  const second: WindowAttentionPayload[] = [];
  onWindowAttention((payload) => first.push(payload));
  onWindowAttention((payload) => second.push(payload));

  expect(first).toEqual([ATTENDED]);
  expect(second).toEqual([ATTENDED]);

  broadcast(UNFOCUSED);

  expect(first).toEqual([ATTENDED, UNFOCUSED]);
  expect(second).toEqual([ATTENDED, UNFOCUSED]);
});

test("replays the latest window-attention payload, not the first", () => {
  const { broadcast, ipc } = attentionIpc();
  const onWindowAttention = createWindowAttentionSubscriber(ipc);

  broadcast(ATTENDED);
  broadcast(UNFOCUSED);

  const received: WindowAttentionPayload[] = [];
  onWindowAttention((payload) => received.push(payload));

  expect(received).toEqual([UNFOCUSED]);
});

test("stops window-attention delivery once the subscriber unsubscribes", () => {
  const { broadcast, ipc } = attentionIpc();
  const onWindowAttention = createWindowAttentionSubscriber(ipc);

  const received: WindowAttentionPayload[] = [];
  const unsubscribe = onWindowAttention((payload) => received.push(payload));
  unsubscribe();

  broadcast(ATTENDED);

  expect(received).toEqual([]);
});

test("does not replay window attention after the subscriber unsubscribes", () => {
  const { broadcast, ipc } = attentionIpc();
  const onWindowAttention = createWindowAttentionSubscriber(ipc);

  broadcast(ATTENDED);

  const received: WindowAttentionPayload[] = [];
  const unsubscribe = onWindowAttention((payload) => received.push(payload));
  unsubscribe();

  broadcast(UNFOCUSED);

  expect(received).toEqual([ATTENDED]);
});

test("skips a window-attention subscriber that unsubscribes mid-broadcast", () => {
  const { broadcast, ipc } = attentionIpc();
  const onWindowAttention = createWindowAttentionSubscriber(ipc);

  const second: WindowAttentionPayload[] = [];
  let unsubscribeSecond = (): void => undefined;
  onWindowAttention(() => {
    unsubscribeSecond();
  });
  unsubscribeSecond = onWindowAttention((payload) => second.push(payload));

  broadcast(ATTENDED);

  expect(second).toEqual([]);
});
