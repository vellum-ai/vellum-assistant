import { expect, mock, test } from "bun:test";
import type { IpcRenderer } from "electron";
import { readdirSync } from "node:fs";
import path from "node:path";

import {
  BridgeCapabilityRegistry,
  installCapabilityModules,
  type CapabilityModuleExport,
} from "@vellumai/electron-desktop/capability-registry";
import { VELLUM_BRIDGE_KEYS, type VellumBridge } from "@vellumai/ipc-contract";

const exposed = new Map<string, unknown>();
const ipcRenderer = {
  invoke: mock(() => Promise.resolve()),
  off: mock(() => undefined),
  on: mock(() => undefined),
  send: mock(() => undefined),
  sendSync: mock(() => null),
};
mock.module("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.set(key, value);
    },
  },
  ipcRenderer,
  webUtils: { getPathForFile: mock(() => "") },
}));

const { createWindowsCoreBridge, WINDOWS_NOT_APPLICABLE_CAPABILITIES } =
  await import("./core-capabilities");

// Every real feature module, loaded from disk the way the production glob
// does, so cross-module bridge-key collisions (which kill the whole
// `window.vellum` bridge at preload time) surface here.
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

const composeWindowsBridge = (): Partial<VellumBridge> => {
  const registry = new BridgeCapabilityRegistry<VellumBridge>(
    createWindowsCoreBridge(ipcRenderer as unknown as IpcRenderer),
  );
  installCapabilityModules(registry, featureModules);
  return registry.build();
};

// The macOS preload is the parity reference: it exposes its bridge on import.
await import("../../../macos/src/preload/index");
const macBridge = exposed.get("vellum") as VellumBridge;

/** Dotted paths of every leaf (method or scalar) under a bridge value. */
const surface = (value: unknown, prefix = ""): string[] => {
  if (typeof value !== "object" || value === null) {
    return [prefix];
  }
  return Object.entries(value)
    .flatMap(([key, child]) =>
      surface(child, prefix ? `${prefix}.${key}` : key),
    )
    .sort();
};

const NOT_APPLICABLE: readonly string[] = WINDOWS_NOT_APPLICABLE_CAPABILITIES;
const required = VELLUM_BRIDGE_KEYS.filter(
  (key) => !NOT_APPLICABLE.includes(key),
);

// Windows draws its own menu bar and themes the native caption buttons.
const WINDOWS_ONLY_SURFACE = [
  "mainWindow.setTitleBarOverlay",
  "menu.popup",
  "menu.titles",
];
// The Fn push-to-talk key is a macOS helper contract; Windows uses a
// configurable global chord.
const MACOS_ONLY_SURFACE = [
  "helper.hotkey.fnPushToTalk",
  "helper.hotkey.onEvent",
];

test("the composed Windows bridge satisfies every applicable VellumBridge key", () => {
  const bridge = composeWindowsBridge();

  for (const key of required) {
    expect(bridge[key], key).toBeDefined();
  }
  expect(Object.keys(bridge).sort()).toEqual([...required].sort());
  expect(bridge.hostOS).toBe("windows");
});

test("the Windows bridge matches the macOS bridge surface up to the documented deltas", () => {
  expect(macBridge).toBeDefined();
  expect(macBridge.hostOS).toBe("macos");
  expect(Object.keys(macBridge).sort()).toEqual([...VELLUM_BRIDGE_KEYS].sort());

  const bridge = composeWindowsBridge();
  const shared = required.filter((key) => key !== "hostOS");
  const windowsSurface = shared.flatMap((key) => surface(bridge[key], key));
  const macSurface = shared.flatMap((key) => surface(macBridge[key], key));

  const windowsOnly = windowsSurface.filter((p) => !macSurface.includes(p));
  const macOnly = macSurface.filter((p) => !windowsSurface.includes(p));
  expect(windowsOnly.sort()).toEqual(WINDOWS_ONLY_SURFACE);
  expect(macOnly.sort()).toEqual(MACOS_ONLY_SURFACE);
});
