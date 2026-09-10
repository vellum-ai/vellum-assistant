import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  Notifier,
  NotifierAuthorizationResult,
  NotifierCategory,
} from "./notifier";

const appPath = mkdtempSync(path.join(tmpdir(), "vellum-notifier-"));

const electronApp = {
  isPackaged: false,
  getAppPath: () => appPath,
};

mock.module("electron", () => ({ app: electronApp }));

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
  ensureNotifierDelegate,
  getNotifier,
  isNotifierSupported,
  registerNotifierCategories,
  requestNotifierAuthorization,
  restoreNotifierDelegate,
} = await import("./notifier");

interface FakeNotifier extends Notifier {
  authorizationCalls: number;
  ensureCalls: number;
  restoreCalls: number;
  registered: NotifierCategory[][];
}

const fakeNotifier = (overrides: Partial<Notifier> = {}): FakeNotifier => {
  const fake: FakeNotifier = {
    authorizationCalls: 0,
    ensureCalls: 0,
    restoreCalls: 0,
    registered: [],
    isSupported: () => true,
    requestAuthorization: (callback) => {
      fake.authorizationCalls += 1;
      callback?.({ granted: true });
    },
    registerCategories: (categories) => {
      fake.registered.push(categories);
    },
    ensureDelegate: () => {
      fake.ensureCalls += 1;
    },
    restoreDelegate: () => {
      fake.restoreCalls += 1;
    },
    show: () => undefined,
    ...overrides,
  };
  return fake;
};

const addonPath = path.join(
  appPath,
  "resources",
  "notifier",
  process.arch,
  "vellum-notifier.node",
);

const writeFakeAddon = (): void => {
  mkdirSync(path.dirname(addonPath), { recursive: true });
  writeFileSync(addonPath, "not a mach-o dylib");
};

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
    expect(getNotifier()).toBeNull();
    expect(infos.length).toBe(1);
  });

  test("resolves the addon under resources/notifier/<arch> in a dev build", () => {
    getNotifier();
    expect(String(infos[0]?.[0])).toContain(addonPath);
  });

  test("reports unavailable without throwing when the file is not an addon", () => {
    writeFakeAddon();

    expect(getNotifier()).toBeNull();
    expect(warnings.length).toBe(1);
  });

  test("caches the load result so a failure is not retried per call", () => {
    getNotifier();
    getNotifier();
    getNotifier();
    expect(infos.length).toBe(1);
  });
});

describe("notifier addon path in a packaged app", () => {
  const resourcesPath = path.join(appPath, "packaged-resources");
  const processWithResources = process as unknown as {
    resourcesPath?: string;
  };
  const originalResourcesPath = processWithResources.resourcesPath;

  beforeEach(() => {
    __resetNotifierForTesting();
    infos.length = 0;
    electronApp.isPackaged = true;
    processWithResources.resourcesPath = resourcesPath;
  });

  afterEach(() => {
    electronApp.isPackaged = false;
    if (originalResourcesPath === undefined) {
      delete processWithResources.resourcesPath;
    } else {
      processWithResources.resourcesPath = originalResourcesPath;
    }
  });

  // electron-builder.config.cjs packs resources/notifier to `bin/notifier`, so
  // a change to either side has to move with the other.
  test("resolves the addon under the packed bin/notifier/<arch>", () => {
    getNotifier();

    expect(String(infos[0]?.[0])).toContain(
      path.join(
        resourcesPath,
        "bin",
        "notifier",
        process.arch,
        "vellum-notifier.node",
      ),
    );
  });
});

describe("native notifier kill switch", () => {
  const originalValue = process.env.VELLUM_DISABLE_NATIVE_NOTIFIER;

  beforeEach(() => {
    __resetNotifierForTesting();
    infos.length = 0;
    warnings.length = 0;
    writeFakeAddon();
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.VELLUM_DISABLE_NATIVE_NOTIFIER;
    } else {
      process.env.VELLUM_DISABLE_NATIVE_NOTIFIER = originalValue;
    }
    rmSync(path.join(appPath, "resources"), { recursive: true, force: true });
  });

  test("reports unavailable without touching the addon on disk", () => {
    process.env.VELLUM_DISABLE_NATIVE_NOTIFIER = "1";

    expect(getNotifier()).toBeNull();
    expect(warnings.length).toBe(0);
    expect(String(infos[0]?.[0])).toContain("VELLUM_DISABLE_NATIVE_NOTIFIER=1");
  });

  test("leaves the addon alone for any other value", () => {
    process.env.VELLUM_DISABLE_NATIVE_NOTIFIER = "0";

    expect(getNotifier()).toBeNull();
    expect(warnings.length).toBe(1);
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

  // `resolve` is idempotent, so the first answer stands on its own.
  test("keeps the first answer when the addon answers twice", async () => {
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

describe("isNotifierSupported", () => {
  beforeEach(() => {
    __resetNotifierForTesting();
    warnings.length = 0;
  });

  test("is false when the addon is unavailable", () => {
    expect(isNotifierSupported()).toBe(false);
  });

  test("reports what the addon says", () => {
    __setNotifierForTesting(fakeNotifier());
    expect(isNotifierSupported()).toBe(true);

    __setNotifierForTesting(fakeNotifier({ isSupported: () => false }));
    expect(isNotifierSupported()).toBe(false);
  });

  // Called at boot, where a throw would skip every later install step and the
  // app would come up with no window and no tray.
  test("is false rather than a throw when the probe explodes", () => {
    __setNotifierForTesting(
      fakeNotifier({
        isSupported: () => {
          throw new Error("addon exploded");
        },
      }),
    );

    expect(isNotifierSupported()).toBe(false);
    expect(warnings.length).toBe(1);
  });
});

describe("notifier categories and delegate seat", () => {
  beforeEach(() => {
    __resetNotifierForTesting();
    warnings.length = 0;
  });

  test("do nothing when the addon is unavailable", () => {
    expect(() => {
      registerNotifierCategories([{ categoryId: "a", actions: [] }]);
      ensureNotifierDelegate();
      restoreNotifierDelegate();
    }).not.toThrow();
  });

  test("pass the categories through and hand the delegate back", () => {
    const notifier = fakeNotifier();
    __setNotifierForTesting(notifier);

    registerNotifierCategories([{ categoryId: "a", actions: ["Allow"] }]);
    ensureNotifierDelegate();
    restoreNotifierDelegate();

    expect(notifier.registered).toEqual([
      [{ categoryId: "a", actions: ["Allow"] }],
    ]);
    expect(notifier.ensureCalls).toBe(1);
    expect(notifier.restoreCalls).toBe(1);
  });

  // A packed addon built before the export loads fine and simply has no
  // re-assertion to make, so the call is a no-op rather than a throw.
  test("skip the re-assertion on an addon without the export", () => {
    const notifier = fakeNotifier();
    delete notifier.ensureDelegate;
    __setNotifierForTesting(notifier);

    expect(() => ensureNotifierDelegate()).not.toThrow();
    expect(warnings.length).toBe(0);
  });

  test("swallow an addon that throws", () => {
    __setNotifierForTesting(
      fakeNotifier({
        registerCategories: () => {
          throw new Error("addon exploded");
        },
        ensureDelegate: () => {
          throw new Error("addon exploded");
        },
        restoreDelegate: () => {
          throw new Error("addon exploded");
        },
      }),
    );

    registerNotifierCategories([]);
    ensureNotifierDelegate();
    restoreNotifierDelegate();
    expect(warnings.length).toBe(3);
  });
});
