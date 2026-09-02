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

test("creates the window-attention subscriber", () => {
  type AttentionHandler = (
    event: unknown,
    payload: WindowAttentionPayload,
  ) => void;
  let handler: AttentionHandler | null = null;
  const on = mock((_channel: string, h: AttentionHandler) => {
    handler = h;
  });
  const off = mock(() => undefined);
  const ipc = {
    invoke: mock(() => Promise.resolve()),
    send: mock(() => undefined),
    on,
    off,
  } as unknown as Pick<IpcRenderer, "invoke" | "off" | "on" | "send">;
  const onWindowAttention = createWindowAttentionSubscriber(ipc);

  const received: WindowAttentionPayload[] = [];
  const unsubscribe = onWindowAttention((payload) => received.push(payload));

  expect(on).toHaveBeenCalledWith(WINDOW_ATTENTION, expect.any(Function));
  handler!({}, { visible: true, focused: false, minimized: false });
  expect(received).toEqual([
    { visible: true, focused: false, minimized: false },
  ]);

  unsubscribe();
  expect(off).toHaveBeenCalledWith(WINDOW_ATTENTION, handler);
});
