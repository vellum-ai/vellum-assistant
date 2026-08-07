import { expect, mock, test } from "bun:test";

import {
  BridgeCapabilityRegistry,
  installCapabilityModules,
} from "@vellumai/electron-desktop/capability-registry";
import type { VellumBridge } from "@vellumai/ipc-contract";

const ipcRenderer = {
  invoke: mock(() => Promise.resolve()),
  off: mock(() => undefined),
  on: mock(() => undefined),
  send: mock(() => undefined),
};
mock.module("electron", () => ({ ipcRenderer }));

const { WINDOWS_CORE_CAPABILITIES } = await import("./core-capabilities");
const commands = (await import("./features/commands")).default;
const presence = (await import("./features/presence")).default;

test("composes the real Windows preload capability modules", () => {
  const registry = new BridgeCapabilityRegistry<VellumBridge>(
    Object.fromEntries(
      WINDOWS_CORE_CAPABILITIES.map((key) => [key, {}]),
    ) as Partial<VellumBridge>,
  );

  expect(() =>
    installCapabilityModules(registry, {
      "./features/commands.ts": { default: commands },
      "./features/presence.ts": { default: presence },
    }),
  ).not.toThrow();

  const bridge = registry.build();
  expect(bridge.menu).toBeDefined();
  expect(bridge.featureFlags).toBeDefined();
});
