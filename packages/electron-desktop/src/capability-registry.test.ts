import { expect, test } from "bun:test";

import {
  BridgeCapabilityRegistry,
  DesktopCapabilityRegistry,
  capabilityToken,
  installCapabilityModules,
} from "./capability-registry";

test("registry stores typed providers and rejects duplicates", () => {
  const registry = new DesktopCapabilityRegistry();
  const token = capabilityToken<{ run: () => string }>("commands");
  const provider = { run: () => "done" };

  registry.provide(token, provider);
  expect(registry.require(token).run()).toBe("done");
  expect(() => registry.provide(token, provider)).toThrow(/already registered/);
});

test("registry keeps unavailable providers absent", () => {
  const registry = new DesktopCapabilityRegistry();
  const token = capabilityToken<string>("missing");

  expect(registry.get(token)).toBeUndefined();
  expect(() => registry.require(token)).toThrow(/unavailable/);
});

test("modules install in stable path order", () => {
  const installed: string[] = [];
  installCapabilityModules(installed, {
    "./features/z.ts": {
      default: { id: "z", install: (target) => target.push("z") },
    },
    "./features/a.ts": {
      default: { id: "a", install: (target) => target.push("a") },
    },
  });

  expect(installed).toEqual(["a", "z"]);
});

test("module installation rejects duplicate IDs", () => {
  const modules = {
    "./a.ts": { default: { id: "same", install: () => undefined } },
    "./b.ts": { default: { id: "same", install: () => undefined } },
  };

  expect(() => installCapabilityModules({}, modules)).toThrow(
    /Duplicate capability module/,
  );
});

test("bridge registry composes namespaces", () => {
  interface Bridge {
    app: { version: string };
    power: { ready: boolean };
  }
  const registry = new BridgeCapabilityRegistry<Bridge>({
    app: { version: "1.0.0" },
  });

  registry.contribute("power", { ready: true });
  expect(registry.build().app?.version).toBe("1.0.0");
  expect(registry.build().power?.ready).toBe(true);
});
