import { expect, mock, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";

import {
  BridgeCapabilityRegistry,
  installCapabilityModules,
  type CapabilityModuleExport,
} from "@vellumai/electron-desktop/capability-registry";
import type { VellumBridge } from "@vellumai/ipc-contract";

const ipcRenderer = {
  invoke: mock(() => Promise.resolve()),
  off: mock(() => undefined),
  on: mock(() => undefined),
  send: mock(() => undefined),
};
const webUtils = {
  getPathForFile: mock(() => ""),
};
mock.module("electron", () => ({ ipcRenderer, webUtils }));

const { WINDOWS_CORE_CAPABILITIES } = await import("./core-capabilities");

// Every real feature module, loaded from disk the way the production glob
// does. A hand-picked subset here would miss cross-module bridge-key
// collisions, which throw at preload load time and silently kill the whole
// `window.vellum` bridge in the running app.
const featuresDir = path.join(import.meta.dir, "features");
const featureModules: Record<
  string,
  CapabilityModuleExport<BridgeCapabilityRegistry<VellumBridge>>
> = {};
for (const file of readdirSync(featuresDir)) {
  if (!file.endsWith(".ts") || file.endsWith(".test.ts")) {
    continue;
  }
  featureModules[`./features/${file}`] = (await import(
    path.join(featuresDir, file)
  )) as CapabilityModuleExport<BridgeCapabilityRegistry<VellumBridge>>;
}

test("composes the real Windows preload capability modules", () => {
  const registry = new BridgeCapabilityRegistry<VellumBridge>(
    Object.fromEntries(
      WINDOWS_CORE_CAPABILITIES.map((key) => [key, {}]),
    ) as Partial<VellumBridge>,
  );

  expect(Object.keys(featureModules).length).toBeGreaterThan(0);
  expect(() =>
    installCapabilityModules(registry, featureModules),
  ).not.toThrow();

  const bridge = registry.build();
  expect(bridge.menu).toBeDefined();
  expect(bridge.featureFlags).toBeDefined();
  expect(bridge.auth).toBeDefined();
});
