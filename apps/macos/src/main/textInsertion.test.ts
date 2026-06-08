import { describe, expect, mock, test } from "bun:test";

import {
  type TextInsertionDeps,
  typeIntoFrontAppWithDeps,
} from "./textInsertion";

type Harness = {
  deps: TextInsertionDeps;
  getClipboardText: () => string;
  setClipboardText: (text: string) => void;
  flushTimers: () => void;
  writes: string[];
  hideApp: ReturnType<typeof mock>;
  runAppleScript: ReturnType<typeof mock>;
};

const createHarness = ({
  focused = false,
  initialClipboard = "previous clipboard",
  runAppleScript = () => Promise.resolve(),
}: {
  focused?: boolean;
  initialClipboard?: string;
  runAppleScript?: () => Promise<unknown>;
} = {}): Harness => {
  let clipboardText = initialClipboard;
  const timers: Array<() => void> = [];
  const writes: string[] = [];
  const hideApp = mock(() => undefined);
  const runAppleScriptMock = mock((_script: string) => runAppleScript());

  return {
    deps: {
      getFocusedWindow: () => (focused ? ({} as never) : null),
      readClipboardText: () => clipboardText,
      writeClipboardText: (text: string) => {
        clipboardText = text;
        writes.push(text);
      },
      hideApp,
      runAppleScript: runAppleScriptMock,
      setTimeout: (callback: () => void) => {
        timers.push(callback);
      },
      sleep: () => Promise.resolve(),
    },
    getClipboardText: () => clipboardText,
    setClipboardText: (text: string) => {
      clipboardText = text;
    },
    flushTimers: () => {
      for (const timer of timers.splice(0)) timer();
    },
    writes,
    hideApp,
    runAppleScript: runAppleScriptMock,
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
  });
});
