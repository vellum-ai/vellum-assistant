import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type ConflictType = "exists" | "existsAndRunning";
type ConflictHandler = (conflictType: ConflictType) => boolean;

interface MoveOptions {
  conflictHandler: ConflictHandler;
}

const appState = {
  isPackaged: true,
  inApplicationsFolder: false,
  /** What `moveToApplicationsFolder` does: move, refuse, or throw. */
  move: "succeeds" as "succeeds" | "declines" | "throws",
  /** Conflict fed to the handler before the move resolves, if any. */
  conflict: null as ConflictType | null,
};

mock.module("electron", () => ({
  app: {
    // `./logger` pulls in electron-log, which probes these on import.
    isReady: () => false,
    whenReady: () => Promise.resolve(),
    on: () => undefined,
    off: () => undefined,
    getPath: () => "/tmp",
    getName: () => "Vellum",
    getVersion: () => "0.0.0-test",
    get isPackaged() {
      return appState.isPackaged;
    },
    isInApplicationsFolder: () => appState.inApplicationsFolder,
    moveToApplicationsFolder: (options: MoveOptions) => {
      if (appState.conflict) {
        const proceed = options.conflictHandler(appState.conflict);
        if (!proceed) return false;
      }
      if (appState.move === "throws") {
        throw new Error("Could not create a temporary directory");
      }
      return appState.move === "succeeds";
    },
  },
  // The install splash resolves through `ready-to-show`; fire it synchronously
  // so the 150ms paint delay is the only wait per case.
  BrowserWindow: class {
    once(event: string, handler: () => void) {
      if (event === "ready-to-show") handler();
      return this;
    }
    show() {}
    close() {}
    isDestroyed() {
      return false;
    }
    loadURL() {
      return Promise.resolve();
    }
  },
}));

const { relocateToApplicationsFolder } = await import(
  "./move-to-applications"
);
const { getInstallLocation, markRelocationSkipped, __resetForTesting } =
  await import("./install-location");

describe("relocateToApplicationsFolder", () => {
  beforeEach(() => {
    __resetForTesting();
    appState.isPackaged = true;
    appState.inApplicationsFolder = false;
    appState.move = "succeeds";
    appState.conflict = null;
  });

  afterEach(() => {
    __resetForTesting();
  });

  test("reports `relocating` and returns true when the move succeeds", async () => {
    expect(await relocateToApplicationsFolder()).toBe(true);
    expect(getInstallLocation()).toBe("relocating");
  });

  test("reports `applications` when already installed", async () => {
    appState.inApplicationsFolder = true;

    expect(await relocateToApplicationsFolder()).toBe(false);
    expect(getInstallLocation()).toBe("applications");
  });

  test("reports `unpackaged` for a dev build", async () => {
    appState.isPackaged = false;

    expect(await relocateToApplicationsFolder()).toBe(false);
    expect(getInstallLocation()).toBe("unpackaged");
  });

  test("distinguishes a running /Applications copy from a plain refusal", async () => {
    appState.conflict = "existsAndRunning";

    expect(await relocateToApplicationsFolder()).toBe(false);
    expect(getInstallLocation()).toBe("conflict-exists-and-running");
  });

  test("overwrites a stale copy rather than refusing", async () => {
    appState.conflict = "exists";

    expect(await relocateToApplicationsFolder()).toBe(true);
    expect(getInstallLocation()).toBe("relocating");
  });

  test("reports `declined` when the move returns false on its own", async () => {
    appState.move = "declines";

    expect(await relocateToApplicationsFolder()).toBe(false);
    expect(getInstallLocation()).toBe("declined");
  });

  test("reports `failed` when the move throws", async () => {
    appState.move = "throws";

    expect(await relocateToApplicationsFolder()).toBe(false);
    expect(getInstallLocation()).toBe("failed");
  });
});

describe("markRelocationSkipped", () => {
  beforeEach(() => {
    __resetForTesting();
    appState.isPackaged = true;
    appState.inApplicationsFolder = false;
  });

  test("attributes a packaged app left outside /Applications to the skip", () => {
    markRelocationSkipped();

    expect(getInstallLocation()).toBe("skipped-pending-open");
  });

  test("reports `applications` when the skipped launch was already installed", () => {
    appState.inApplicationsFolder = true;
    markRelocationSkipped();

    expect(getInstallLocation()).toBe("applications");
  });

  test("leaves a dev build as `unpackaged`", () => {
    appState.isPackaged = false;
    markRelocationSkipped();

    expect(getInstallLocation()).toBe("unpackaged");
  });
});
