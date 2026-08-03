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

/** Queued `showMessageBox` answers, consumed in order. */
let dialogAnswers: { response: number; checkboxChecked?: boolean }[] = [];
const dialogCalls: { message?: string }[] = [];
let revealedInFinder = 0;
let settingsStore: Record<string, unknown> = {};

mock.module("./settings", () => ({
  readSetting: (key: string) => settingsStore[key] ?? null,
  writeSetting: (key: string, value: unknown) => {
    settingsStore[key] = value;
  },
}));

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
        if (!proceed) {
          return false;
        }
      }
      if (appState.move === "throws") {
        throw new Error("Could not create a temporary directory");
      }
      return appState.move === "succeeds";
    },
  },
  dialog: {
    showMessageBox: (options: { message?: string }) => {
      dialogCalls.push({ ...(options.message == null ? {} : { message: options.message }) });
      const next = dialogAnswers.shift() ?? { response: 1 };
      return Promise.resolve({
        response: next.response,
        checkboxChecked: next.checkboxChecked ?? false,
      });
    },
  },
  shell: {
    showItemInFolder: () => {
      revealedInFinder += 1;
    },
  },
  // The install splash resolves through `ready-to-show`; fire it synchronously
  // so the 150ms paint delay is the only wait per case.
  BrowserWindow: class {
    once(event: string, handler: () => void) {
      if (event === "ready-to-show") {
        handler();
      }
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

const { relocateToApplicationsFolder, promptToRelocateIfStranded } =
  await import("./move-to-applications");
const {
  getInstallLocation,
  markRelocationSkipped,
  recordInstallLocation,
  __resetForTesting,
} = await import("./install-location");

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

describe("promptToRelocateIfStranded", () => {
  beforeEach(() => {
    __resetForTesting();
    appState.isPackaged = true;
    appState.inApplicationsFolder = false;
    appState.move = "succeeds";
    appState.conflict = null;
    dialogAnswers = [];
    dialogCalls.length = 0;
    revealedInFinder = 0;
    settingsStore = {};
  });

  test("stays quiet when the app is already in /Applications", async () => {
    appState.inApplicationsFolder = true;

    await promptToRelocateIfStranded();

    expect(dialogCalls).toHaveLength(0);
  });

  test("stays quiet for an unpackaged dev build", async () => {
    appState.isPackaged = false;

    await promptToRelocateIfStranded();

    expect(dialogCalls).toHaveLength(0);
  });

  test("stays quiet once the user has opted out", async () => {
    settingsStore["suppressRelocationPrompt"] = true;

    await promptToRelocateIfStranded();

    expect(dialogCalls).toHaveLength(0);
  });

  // A `.vellum` file or deep-link launch defers relocation on purpose: the
  // event lives only in this process's pending buffers, so the relaunch that
  // accepting the offer triggers would drop it.
  test("stays quiet on a launch that deferred relocation for a pending open", async () => {
    markRelocationSkipped();
    expect(getInstallLocation()).toBe("skipped-pending-open");

    await promptToRelocateIfStranded();

    expect(dialogCalls).toHaveLength(0);
  });

  test("cannot relaunch a pending-open launch out from under the buffer", async () => {
    markRelocationSkipped();
    dialogAnswers = [{ response: 0 }];

    await promptToRelocateIfStranded();

    // Never reached the move, so the buffered file or link survives.
    expect(getInstallLocation()).toBe("skipped-pending-open");
  });

  test("still prompts a stranded launch that carried no pending open", async () => {
    recordInstallLocation("failed");
    dialogAnswers = [{ response: 1 }];

    await promptToRelocateIfStranded();

    expect(dialogCalls).toHaveLength(1);
  });

  test("retries the move when the user accepts", async () => {
    dialogAnswers = [{ response: 0 }];

    await promptToRelocateIfStranded();

    expect(dialogCalls).toHaveLength(1);
    expect(getInstallLocation()).toBe("relocating");
  });

  test("does not move when the user declines", async () => {
    dialogAnswers = [{ response: 1 }];

    await promptToRelocateIfStranded();

    expect(getInstallLocation()).toBe("unpackaged");
    expect(settingsStore["suppressRelocationPrompt"]).toBeUndefined();
  });

  test("remembers the opt-out when the checkbox is ticked", async () => {
    dialogAnswers = [{ response: 1, checkboxChecked: true }];

    await promptToRelocateIfStranded();

    expect(settingsStore["suppressRelocationPrompt"]).toBe(true);
  });

  test("falls back to Finder when the retried move also fails", async () => {
    appState.move = "throws";
    dialogAnswers = [{ response: 0 }, { response: 0 }];

    await promptToRelocateIfStranded();

    expect(dialogCalls).toHaveLength(2);
    expect(revealedInFinder).toBe(1);
    expect(getInstallLocation()).toBe("failed");
  });

  test("leaves Finder alone when the user closes the fallback", async () => {
    appState.move = "throws";
    dialogAnswers = [{ response: 0 }, { response: 1 }];

    await promptToRelocateIfStranded();

    expect(revealedInFinder).toBe(0);
  });
});
