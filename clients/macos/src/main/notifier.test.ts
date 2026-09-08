import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Notifier, NotifierAuthorizationResult } from "./notifier";

const appPath = mkdtempSync(path.join(tmpdir(), "vellum-notifier-"));

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => appPath,
  },
}));

const warnings: unknown[][] = [];
const infos: unknown[][] = [];
mock.module("./logger", () => ({
  default: {
    info: (...args: unknown[]) => infos.push(args),
    warn: (...args: unknown[]) => warnings.push(args),
  },
}));

const {
  __resetNotifierForTesting,
  __setNotifierForTesting,
  getNotifier,
  isNotifierAvailable,
  reassertNotifierDelegate,
  requestNotifierAuthorization,
  startNotifierDelegateGuard,
} = await import("./notifier");

interface FakeNotifier extends Notifier {
  authorizationCalls: number;
  reassertCalls: number;
}

const fakeNotifier = (overrides: Partial<Notifier> = {}): FakeNotifier => {
  const fake: FakeNotifier = {
    authorizationCalls: 0,
    reassertCalls: 0,
    isSupported: () => true,
    requestAuthorization: (callback) => {
      fake.authorizationCalls += 1;
      callback?.({ granted: true });
    },
    reassertDelegate: () => {
      fake.reassertCalls += 1;
    },
    show: () => undefined,
    ...overrides,
  };
  return fake;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const addonPath = path.join(
  appPath,
  "resources",
  "notifier",
  process.arch,
  "vellum-notifier.node",
);

afterAll(() => {
  rmSync(appPath, { recursive: true, force: true });
});

describe("notifier addon loading", () => {
  beforeEach(() => {
    __resetNotifierForTesting();
    warnings.length = 0;
    infos.length = 0;
    rmSync(path.join(appPath, "resources"), { recursive: true, force: true });
  });

  test("reports unavailable without throwing when the addon is missing", () => {
    expect(isNotifierAvailable()).toBe(false);
    expect(getNotifier()).toBeNull();
    expect(infos.length).toBe(1);
  });

  test("resolves the addon under resources/notifier/<arch> in a dev build", () => {
    isNotifierAvailable();
    expect(String(infos[0]?.[0])).toContain(addonPath);
  });

  test("reports unavailable without throwing when the file is not an addon", () => {
    mkdirSync(path.dirname(addonPath), { recursive: true });
    writeFileSync(addonPath, "not a mach-o dylib");

    expect(isNotifierAvailable()).toBe(false);
    expect(warnings.length).toBe(1);
  });

  test("caches the load result so a failure is not retried per call", () => {
    isNotifierAvailable();
    isNotifierAvailable();
    isNotifierAvailable();
    expect(infos.length).toBe(1);
  });
});

describe("notifier authorization", () => {
  beforeEach(() => {
    __resetNotifierForTesting();
    warnings.length = 0;
  });

  test("resolves null when the addon is unavailable", async () => {
    expect(await requestNotifierAuthorization()).toBeNull();
  });

  test("resolves the addon's answer", async () => {
    const notifier = fakeNotifier();
    __setNotifierForTesting(notifier);

    expect(await requestNotifierAuthorization()).toEqual({ granted: true });
    expect(notifier.authorizationCalls).toBe(1);
  });

  test("resolves the denial rather than throwing it away", async () => {
    const denied: NotifierAuthorizationResult = {
      granted: false,
      error: "Notifications are not authorized",
    };
    __setNotifierForTesting(
      fakeNotifier({
        requestAuthorization: (callback) => callback?.(denied),
      }),
    );

    expect(await requestNotifierAuthorization()).toEqual(denied);
  });

  test("resolves null when the addon throws", async () => {
    __setNotifierForTesting(
      fakeNotifier({
        requestAuthorization: () => {
          throw new Error("addon exploded");
        },
      }),
    );

    expect(await requestNotifierAuthorization()).toBeNull();
    expect(warnings.length).toBe(1);
  });

  test("ignores a second answer from the addon", async () => {
    __setNotifierForTesting(
      fakeNotifier({
        requestAuthorization: (callback) => {
          callback?.({ granted: true });
          callback?.({ granted: false });
        },
      }),
    );

    expect(await requestNotifierAuthorization()).toEqual({ granted: true });
  });
});

describe("notifier delegate guard", () => {
  beforeEach(() => {
    __resetNotifierForTesting();
    warnings.length = 0;
  });

  test("does nothing when the addon is unavailable", () => {
    const stop = startNotifierDelegateGuard(1);
    expect(() => {
      reassertNotifierDelegate();
    }).not.toThrow();
    stop();
  });

  test("reclaims the delegate immediately and then on the interval", async () => {
    const notifier = fakeNotifier();
    __setNotifierForTesting(notifier);

    const stop = startNotifierDelegateGuard(1);
    expect(notifier.reassertCalls).toBe(1);
    await sleep(20);
    expect(notifier.reassertCalls).toBeGreaterThan(1);

    stop();
    const afterStop = notifier.reassertCalls;
    await sleep(20);
    expect(notifier.reassertCalls).toBe(afterStop);
  });

  test("swallows an addon that throws on reassert", () => {
    __setNotifierForTesting(
      fakeNotifier({
        reassertDelegate: () => {
          throw new Error("addon exploded");
        },
      }),
    );

    reassertNotifierDelegate();
    expect(warnings.length).toBe(1);
  });
});
