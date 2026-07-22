import { describe, expect, mock, test } from "bun:test";

import {
  type ClipboardSnapshot,
  type TextInsertionDeps,
  typeIntoFrontAppWithDeps,
} from "./textInsertion";

type Harness = {
  deps: TextInsertionDeps;
  getClipboardText: () => string;
  getClipboardSnapshot: () => ClipboardSnapshot;
  setClipboardText: (text: string) => void;
  flushTimers: () => void;
  writes: string[];
  restoredSnapshots: ClipboardSnapshot[];
  hideApp: ReturnType<typeof mock>;
  showApp: ReturnType<typeof mock>;
  runAppleScript: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
};

const snapshotText = (snapshot: ClipboardSnapshot): string =>
  snapshot.kind === "structured" ? (snapshot.data.text ?? "") : "";

const textSnapshot = (text: string): ClipboardSnapshot => ({
  kind: "structured",
  data: { text },
});

const createHarness = ({
  focused = false,
  initialClipboard = "previous clipboard",
  initialClipboardSnapshot,
  runAppleScript = () => Promise.resolve(),
}: {
  focused?: boolean;
  initialClipboard?: string;
  initialClipboardSnapshot?: ClipboardSnapshot;
  runAppleScript?: () => Promise<unknown>;
} = {}): Harness => {
  let clipboardSnapshot = initialClipboardSnapshot ?? textSnapshot(initialClipboard);
  let clipboardText = snapshotText(clipboardSnapshot);
  const timers: Array<() => void> = [];
  const writes: string[] = [];
  const restoredSnapshots: ClipboardSnapshot[] = [];
  const hideApp = mock(() => undefined);
  const showApp = mock(() => undefined);
  const runAppleScriptMock = mock((_script: string) => runAppleScript());
  const warn = mock(() => undefined);

  return {
    deps: {
      getFocusedWindow: () => (focused ? ({} as never) : null),
      readClipboardSnapshot: () => clipboardSnapshot,
      restoreClipboardSnapshot: (snapshot: ClipboardSnapshot) => {
        clipboardSnapshot = snapshot;
        clipboardText = snapshotText(snapshot);
        restoredSnapshots.push(snapshot);
      },
      readClipboardText: () => clipboardText,
      writeClipboardText: (text: string) => {
        clipboardText = text;
        clipboardSnapshot = textSnapshot(text);
        writes.push(text);
      },
      hideApp,
      showApp,
      runAppleScript: runAppleScriptMock,
      warn,
      setTimeout: (callback: () => void) => {
        timers.push(callback);
      },
      sleep: () => Promise.resolve(),
    },
    getClipboardText: () => clipboardText,
    getClipboardSnapshot: () => clipboardSnapshot,
    setClipboardText: (text: string) => {
      clipboardText = text;
      clipboardSnapshot = textSnapshot(text);
    },
    flushTimers: () => {
      for (const timer of timers.splice(0)) timer();
    },
    writes,
    restoredSnapshots,
    hideApp,
    showApp,
    runAppleScript: runAppleScriptMock,
    warn,
  };
};

describe("typeIntoFrontApp", () => {
  test("skips paste when a Vellum window is focused", async () => {
    const harness = createHarness({ focused: true });

    await expect(
      typeIntoFrontAppWithDeps("hello", harness.deps),
    ).resolves.toEqual({ status: "vellum-focused" });

    expect(harness.runAppleScript).not.toHaveBeenCalled();
    expect(harness.hideApp).not.toHaveBeenCalled();
    expect(harness.writes).toEqual([]);
  });

  test("restores the previous clipboard text after paste settles", async () => {
    const harness = createHarness({ initialClipboard: "user clipboard" });

    await expect(
      typeIntoFrontAppWithDeps("dictated text", harness.deps),
    ).resolves.toEqual({ status: "inserted" });
    expect(harness.getClipboardText()).toBe("dictated text");

    harness.flushTimers();
    expect(harness.getClipboardText()).toBe("user clipboard");
  });

  test("restores non-text clipboard data after paste settles", async () => {
    const previousClipboard: ClipboardSnapshot = {
      kind: "raw",
      format: "public.file-url",
      buffer: Buffer.from("file:///tmp/example.txt"),
    };
    const harness = createHarness({
      initialClipboardSnapshot: previousClipboard,
    });

    await expect(
      typeIntoFrontAppWithDeps("dictated text", harness.deps),
    ).resolves.toEqual({ status: "inserted" });
    expect(harness.getClipboardText()).toBe("dictated text");

    harness.flushTimers();
    expect(harness.getClipboardSnapshot()).toEqual(previousClipboard);
    expect(harness.restoredSnapshots).toEqual([previousClipboard]);
  });

  test("does not clobber the clipboard if the user copies during paste", async () => {
    const harness = createHarness({ initialClipboard: "user clipboard" });

    await typeIntoFrontAppWithDeps("dictated text", harness.deps);
    harness.setClipboardText("new user copy");
    harness.flushTimers();

    expect(harness.getClipboardText()).toBe("new user copy");
  });

  test("maps Automation denial to a settings result", async () => {
    const error = Object.assign(new Error("execution failed"), {
      stderr: "Not authorized to send Apple events to System Events. (-1743)",
    });
    const harness = createHarness({
      runAppleScript: () => Promise.reject(error),
    });

    await expect(
      typeIntoFrontAppWithDeps("dictated text", harness.deps),
    ).resolves.toEqual({ status: "automation-denied" });

    harness.flushTimers();
    expect(harness.getClipboardText()).toBe("previous clipboard");
    expect(harness.showApp).toHaveBeenCalledTimes(1);
    expect(harness.warn).toHaveBeenCalledTimes(1);
  });
});
