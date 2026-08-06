import { expect, mock, test } from "bun:test";
import type { VellumBridge } from "@vellumai/ipc-contract";

const invokeMock = mock(async (_channel: string) => null);
const sendMock = mock((_channel: string, _accepted: boolean) => undefined);

mock.module("electron", () => ({
  ipcRenderer: { invoke: invokeMock, send: sendMock },
}));

const { BridgeCapabilityRegistry } =
  await import("@vellumai/electron-desktop/capability-registry");
const { default: bundles } = await import("./features/bundles");

test("contributes the bundle confirmation bridge", async () => {
  const registry = new BridgeCapabilityRegistry<VellumBridge>({});
  bundles.install(registry);
  const bridge = registry.build();

  await bridge.bundleConfirm?.getData();
  bridge.bundleConfirm?.respond(true);

  expect(invokeMock).toHaveBeenCalledWith("vellum:bundleConfirm:getData");
  expect(sendMock).toHaveBeenCalledWith("vellum:bundleConfirm:respond", true);
});
