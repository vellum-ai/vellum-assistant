import { expect, mock, test } from "bun:test";
import type { IpcRenderer } from "electron";

import { createBundleConfirmBridge } from "./preload";

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
