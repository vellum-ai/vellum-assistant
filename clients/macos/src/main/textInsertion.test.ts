import { describe, expect, mock, test } from "bun:test";

import type { ShortcutOutcome } from "./hotkey-helper";
import {
  type ClipboardSnapshot,
  type TextInsertionDeps,
  typeIntoFrontAppWithDeps,
  undoInFrontAppWithDeps,
} from "./textInsertion";

type Harness = {
  deps: TextInsertionDeps;
  getClipboardText: () => string;
  getClipboardSnapshot: () => ClipboardSnapshot;
  setClipboardText: (text: string) => void;
  flushTimers: () => void;
  writes: string[];
  restoredSnapshots: ClipboardSnapshot[];
  postShortcut: ReturnType<typeof mock>;
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
  takesText = true,
  initialClipboard = "previous clipboard",
  initialClipboardSnapshot,
  helper = "declined",
  helperAnswered = true,
  onPostShortcut,
  runAppleScript = () => Promise.resolve(),
}: {
  focused?: boolean;
  /** Whether the application in front has somewhere for the words to go. */
  takesText?: boolean;
  initialClipboard?: string;
  initialClipboardSnapshot?: ClipboardSnapshot;
  /**
   * What the mac helper says when asked to post the keystroke. `declined` by
   * default, so the cases that do not name it cover the AppleScript path.
   */
  helper?: ShortcutOutcome;
  /** Whether the helper answered the focus read before the paste. */
  helperAnswered?: boolean;
  /** Runs while the helper is being asked, for a user copying meanwhile. */
  onPostShortcut?: () => void;
  runAppleScript?: () => Promise<unknown>;
} = {}): Harness => {
  let clipboardSnapshot = initialClipboardSnapshot ?? textSnapshot(initialClipboard);
  let clipboardText = snapshotText(clipboardSnapshot);
  const timers: Array<() => void> = [];
  const writes: string[] = [];
  const restoredSnapshots: ClipboardSnapshot[] = [];
  const postShortcutMock = mock((_key: "v" | "z") => {
    onPostShortcut?.();
    return Promise.resolve(helper);
  });
  const runAppleScriptMock = mock((_script: string) => runAppleScript());
  const warn = mock(() => undefined);

  return {
    deps: {
      getFocusedWindow: () => (focused ? ({} as never) : null),
      readFrontAppFocus: () =>
        Promise.resolve({ takesText, helperAnswered }),
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
      postShortcut: postShortcutMock,
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
    postShortcut: postShortcutMock,
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

  /**
   * A hold that ends over a web page or a file list has nowhere to put its
   * words. The paste is withheld rather than sent into whatever the keystroke
   * happens to mean there, and the status says so, so the caller knows it
   * still holds the words.
   */
  test("sends no paste when nothing in front takes text", async () => {
    const harness = createHarness({ takesText: false });

    await expect(
      typeIntoFrontAppWithDeps("dictated text", harness.deps),
    ).resolves.toEqual({ status: "no-text-field" });

    expect(harness.runAppleScript).not.toHaveBeenCalled();
  });

  /**
   * The user has not asked for their clipboard to be spent, and the words are
   * about to be offered to them instead. A clipboard taken for a paste that
   * never happens is a cost with nothing bought by it.
   */
  test("leaves the clipboard alone when it withholds the paste", async () => {
    const harness = createHarness({
      takesText: false,
      initialClipboard: "user clipboard",
    });

    await typeIntoFrontAppWithDeps("dictated text", harness.deps);

    expect(harness.writes).toEqual([]);
    expect(harness.getClipboardText()).toBe("user clipboard");
  });

  /**
   * System Events quits itself when idle, and a keystroke that reaches it on
   * the way out fails with -600. The helper posts the paste itself, so that
   * failure never gets the chance to lose the words.
   */
  test("pastes from the helper without going through System Events", async () => {
    const harness = createHarness({
      helper: "posted",
      runAppleScript: () =>
        Promise.reject(
          new Error(
            "System Events got an error: Application isn't running. (-600)",
          ),
        ),
    });

    await expect(
      typeIntoFrontAppWithDeps("dictated text", harness.deps),
    ).resolves.toEqual({ status: "inserted" });

    expect(harness.postShortcut).toHaveBeenCalledWith("v");
    expect(harness.runAppleScript).not.toHaveBeenCalled();
    expect(harness.getClipboardText()).toBe("dictated text");
    harness.flushTimers();
    expect(harness.getClipboardText()).toBe("previous clipboard");
  });

  test("falls back to System Events when the helper cannot post", async () => {
    const harness = createHarness({ helper: "declined" });

    await expect(
      typeIntoFrontAppWithDeps("dictated text", harness.deps),
    ).resolves.toEqual({ status: "inserted" });

    expect(harness.postShortcut).toHaveBeenCalledWith("v");
    expect(harness.runAppleScript).toHaveBeenCalledWith(
      'tell application "System Events" to keystroke "v" using command down',
    );
  });

  /**
   * A reply lost after the request went out may have been lost after the
   * keystroke went too. Pasting again would put the words in twice.
   */
  test("does not paste again when the helper's reply is lost", async () => {
    const harness = createHarness({ helper: "unknown" });

    await expect(
      typeIntoFrontAppWithDeps("dictated text", harness.deps),
    ).resolves.toEqual({ status: "blocked" });

    expect(harness.runAppleScript).not.toHaveBeenCalled();
    harness.flushTimers();
    expect(harness.getClipboardText()).toBe("previous clipboard");
  });

  /**
   * A helper that did not answer the focus read is not asked to paste, so a
   * hung helper cannot hold the clipboard for its whole reply timeout.
   */
  test("goes straight to System Events when the helper did not answer", async () => {
    const harness = createHarness({ helper: "posted", helperAnswered: false });

    await expect(
      typeIntoFrontAppWithDeps("dictated text", harness.deps),
    ).resolves.toEqual({ status: "inserted" });

    expect(harness.postShortcut).not.toHaveBeenCalled();
    expect(harness.runAppleScript).toHaveBeenCalledTimes(1);
  });

  /**
   * What the user copied while the helper was being asked is theirs, and a
   * fallback paste would send it in place of the dictation.
   */
  test("sends no fallback paste once the user has copied something else", async () => {
    let copy: (text: string) => void = () => undefined;
    const harness = createHarness({
      helper: "declined",
      onPostShortcut: () => copy("user's new copy"),
    });
    copy = harness.setClipboardText;

    await expect(
      typeIntoFrontAppWithDeps("dictated text", harness.deps),
    ).resolves.toEqual({ status: "blocked" });

    expect(harness.runAppleScript).not.toHaveBeenCalled();
    harness.flushTimers();
    expect(harness.getClipboardText()).toBe("user's new copy");
  });

  test("asks the helper nothing when it withholds the paste", async () => {
    const harness = createHarness({ takesText: false, helper: "posted" });

    await typeIntoFrontAppWithDeps("dictated text", harness.deps);

    expect(harness.postShortcut).not.toHaveBeenCalled();
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
    expect(harness.warn).toHaveBeenCalledTimes(1);
  });
});

describe("undoInFrontAppWithDeps", () => {
  test("sends the undo keystroke to the application in front", async () => {
    const harness = createHarness();
    const result = await undoInFrontAppWithDeps(harness.deps);

    expect(result).toEqual({ status: "inserted" });
    expect(harness.runAppleScript).toHaveBeenCalledWith(
      'tell application "System Events" to keystroke "z" using command down',
    );
  });

  test("sends the undo from the helper when it can", async () => {
    const harness = createHarness({ helper: "posted" });
    const result = await undoInFrontAppWithDeps(harness.deps);

    expect(result).toEqual({ status: "inserted" });
    expect(harness.postShortcut).toHaveBeenCalledWith("z");
    expect(harness.runAppleScript).not.toHaveBeenCalled();
  });

  test("does not undo again when the helper's reply is lost", async () => {
    const harness = createHarness({ helper: "unknown" });
    const result = await undoInFrontAppWithDeps(harness.deps);

    expect(result).toEqual({ status: "blocked" });
    expect(harness.runAppleScript).not.toHaveBeenCalled();
  });

  test("does nothing while a Vellum window is in front", async () => {
    const harness = createHarness({ focused: true });
    const result = await undoInFrontAppWithDeps(harness.deps);

    expect(result).toEqual({ status: "vellum-focused" });
    expect(harness.runAppleScript).not.toHaveBeenCalled();
  });

  test("reads a refused keystroke as blocked", async () => {
    const harness = createHarness({
      runAppleScript: () => Promise.reject(new Error("no")),
    });
    expect(await undoInFrontAppWithDeps(harness.deps)).toEqual({
      status: "blocked",
    });
  });
});
