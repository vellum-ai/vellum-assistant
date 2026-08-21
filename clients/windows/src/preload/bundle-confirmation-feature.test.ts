import { beforeEach, expect, mock, test } from "bun:test";

import type { VellumBridge } from "@vellumai/ipc-contract";

const invoke = mock(() => Promise.resolve(null));
const send = mock(() => undefined);

mock.module("electron", () => ({
  ipcRenderer: { invoke, send },
}));

const { BridgeCapabilityRegistry } =
  await import("@vellumai/electron-desktop/capability-registry");
const { default: bundleConfirmationFeature } =
  await import("./features/bundle-confirmation");

beforeEach(() => {
  invoke.mockClear();
  send.mockClear();
});

test("exposes bundle confirmation data and responses", async () => {
  const registry = new BridgeCapabilityRegistry<VellumBridge>({});
  bundleConfirmationFeature.install(registry);
  const bridge = registry.build();

  await bridge.bundleConfirm?.getData();
  bridge.bundleConfirm?.respond(true);

  expect(invoke).toHaveBeenCalledWith("vellum:bundleConfirm:getData");
  expect(send).toHaveBeenCalledWith("vellum:bundleConfirm:respond", true);
});
