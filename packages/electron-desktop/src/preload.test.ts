import { expect, mock, test } from "bun:test";
import type { IpcRenderer } from "electron";

import type {
  DownloadDoneEvent,
  WindowAttentionPayload,
} from "@vellumai/ipc-contract";
import {
  NOTIFICATIONS_ACTION,
  NOTIFICATIONS_PREPARE_IDENTITY,
  NOTIFICATIONS_REGISTER_IDENTITY_PUBLISHER,
  NOTIFICATIONS_RESET_IDENTITIES,
  NOTIFICATIONS_SHOW,
  WINDOW_ATTENTION,
} from "@vellumai/ipc-contract";

import {
  createBundleConfirmBridge,
  createDownloadsBridge,
  createNotificationsBridge,
  createWindowAttentionSubscriber,
} from "./preload";

test("creates the notification bridge with optional identity methods", async () => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => void>();
  const invoke = mock((channel: string, _payload?: unknown) =>
    Promise.resolve(
      channel === NOTIFICATIONS_REGISTER_IDENTITY_PUBLISHER
        ? true
        : { success: true },
    ),
  );
  const on = mock(
    (
      channel: string,
      handler: (event: unknown, payload: unknown) => void,
    ) => {
      handlers.set(channel, handler);
    },
  );
  const off = mock(() => undefined);
  const ipc = {
    invoke,
    send: mock(() => undefined),
    on,
    off,
  } as unknown as Pick<IpcRenderer, "invoke" | "off" | "on" | "send">;
  const bridge = createNotificationsBridge(ipc);
  const scopeId = `scope:v1:${"a".repeat(64)}`;
  const identity = {
    scopeId,
    assistantId: "assistant-a",
    nativeSenderId: "native-a",
  };
  const showPayload = {
    category: "notificationIntent" as const,
    title: "Weekly plan",
    body: "Ready",
  };
  const preparePayload = {
    identity,
    scopeEpoch: 1,
    identityRevision: 1,
    name: "Alice",
    nameProvenance: "identity-store" as const,
  };
  const resetPayload = { scopeId, scopeEpoch: 2 };

  await bridge.show(showPayload);
  await bridge.prepareIdentity?.(preparePayload);
  await bridge.resetIdentities?.(resetPayload);

  const registration = invoke.mock.calls.find(
    ([channel]) => channel === NOTIFICATIONS_REGISTER_IDENTITY_PUBLISHER,
  );
  const publisherSessionId = (
    registration?.[1] as { publisherSessionId?: string } | undefined
  )?.publisherSessionId;
  expect(publisherSessionId).toBeString();
  expect(invoke).toHaveBeenCalledWith(NOTIFICATIONS_SHOW, showPayload);
  expect(invoke).toHaveBeenCalledWith(
    NOTIFICATIONS_PREPARE_IDENTITY,
    { ...preparePayload, publisherSessionId },
  );
  expect(invoke).toHaveBeenCalledWith(
    NOTIFICATIONS_RESET_IDENTITIES,
    { ...resetPayload, publisherSessionId },
  );

  const received: unknown[] = [];
  const unsubscribe = bridge.onAction((event) => received.push(event));
  const action = { kind: "click" as const, conversationId: "conv-a" };
  handlers.get(NOTIFICATIONS_ACTION)?.({}, action);
  expect(received).toEqual([action]);
  unsubscribe();
  expect(off).toHaveBeenCalledWith(
    NOTIFICATIONS_ACTION,
    handlers.get(NOTIFICATIONS_ACTION),
  );
});

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
