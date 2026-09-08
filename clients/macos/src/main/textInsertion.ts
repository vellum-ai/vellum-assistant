import {
  BrowserWindow,
  app,
  clipboard,
  shell,
  type Data,
} from "electron";
import { z } from "zod";

import type { TextInsertionResult } from "@vellumai/ipc-contract";

import { runAppleScript } from "./appleScriptExecutor";
import { frontAppTakesText } from "./hotkey-helper";
import { handle } from "./ipc";
import log from "./logger";

const CLIPBOARD_RESTORE_DELAY_MS = 500;
const PASTE_SHORTCUT_SCRIPT =
  'tell application "System Events" to keystroke "v" using command down';
const UNDO_SHORTCUT_SCRIPT =
  'tell application "System Events" to keystroke "z" using command down';

const AUTOMATION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

const FILE_CLIPBOARD_FORMATS = [
  "NSFilenamesPboardType",
  "public.file-url",
  "public/url",
  "text/uri-list",
];

export type { TextInsertionResult };

export type ClipboardSnapshot =
  | { kind: "structured"; data: Data }
  | { kind: "raw"; format: string; buffer: Buffer }
  | { kind: "empty" };

export type TextInsertionDeps = {
  getFocusedWindow: () => BrowserWindow | null;
  readClipboardSnapshot: () => ClipboardSnapshot;
  restoreClipboardSnapshot: (snapshot: ClipboardSnapshot) => void;
  readClipboardText: () => string;
  writeClipboardText: (text: string) => void;

  /**
   * Whether the application in front has something focused that takes text.
   *
   * Injected rather than imported at the call site so a case can drive both
   * answers; see `frontAppTakesText`, which answers yes to everything but a
   * confident no.
   */
  frontAppTakesText: () => Promise<boolean>;

  runAppleScript: (script: string) => Promise<unknown>;
  warn: (...args: unknown[]) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  sleep: (ms: number) => Promise<void>;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const readRawClipboardSnapshot = (
  formats: string[],
  preferredFormats = formats,
): ClipboardSnapshot | null => {
  for (const format of preferredFormats) {
    if (!formats.includes(format)) continue;
    try {
      const buffer = clipboard.readBuffer(format);
      if (buffer.byteLength > 0) {
        return { kind: "raw", format, buffer };
      }
    } catch (err) {
      log.warn("[text-insertion] failed to snapshot clipboard format:", format, err);
    }
  }
  return null;
};

const hasStructuredClipboardData = (data: Data): boolean =>
  Boolean(
    data.text ||
      data.html ||
      data.rtf ||
      data.bookmark ||
      (data.image && !data.image.isEmpty()),
  );

const readClipboardSnapshot = (): ClipboardSnapshot => {
  const formats = clipboard.availableFormats();
  const fileSnapshot = readRawClipboardSnapshot(formats, FILE_CLIPBOARD_FORMATS);
  if (fileSnapshot) {
    return fileSnapshot;
  }

  const data: Data = {};
  const text = clipboard.readText();
  const html = clipboard.readHTML();
  const rtf = clipboard.readRTF();
  const image = clipboard.readImage();
  const bookmark = clipboard.readBookmark();

  if (text) data.text = text;
  if (html) data.html = html;
  if (rtf) data.rtf = rtf;
  if (!image.isEmpty()) data.image = image;
  if (bookmark.url || bookmark.title) {
    data.text ??= bookmark.url;
    if (bookmark.title) data.bookmark = bookmark.title;
  }

  if (hasStructuredClipboardData(data)) {
    return { kind: "structured", data };
  }

  return readRawClipboardSnapshot(formats) ?? { kind: "empty" };
};

const restoreClipboardSnapshot = (snapshot: ClipboardSnapshot): void => {
  switch (snapshot.kind) {
    case "structured":
      clipboard.write(snapshot.data);
      break;
    case "raw":
      clipboard.writeBuffer(snapshot.format, snapshot.buffer);
      break;
    case "empty":
      clipboard.clear();
      break;
  }
};

const defaultDeps: TextInsertionDeps = {
  getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
  readClipboardSnapshot,
  restoreClipboardSnapshot,
  readClipboardText: () => clipboard.readText(),
  writeClipboardText: (text) => clipboard.writeText(text),

  frontAppTakesText,

  runAppleScript,
  warn: (...args) => log.warn(...args),
  setTimeout,
  sleep,
};

const describeError = (err: unknown): string =>
  err instanceof Error
    ? `${err.message}\n${String((err as { stderr?: unknown }).stderr ?? "")}`
    : String(err);

const isAutomationDeniedError = (err: unknown): boolean => {
  const message = describeError(err).toLowerCase();
  return (
    message.includes("-1743") ||
    message.includes("-25211") ||
    message.includes("not authorized") ||
    message.includes("not authorised") ||
    message.includes("not allowed assistive access") ||
    message.includes("not allowed to send apple events") ||
    message.includes("not permitted to send apple events")
  );
};

const scheduleClipboardRestore = (
  deps: TextInsertionDeps,
  previousClipboard: ClipboardSnapshot,
  insertedText: string,
): void => {
  deps.setTimeout(() => {
    if (deps.readClipboardText() === insertedText) {
      deps.restoreClipboardSnapshot(previousClipboard);
    }
  }, CLIPBOARD_RESTORE_DELAY_MS);
};

export const typeIntoFrontAppWithDeps = async (
  text: string,
  deps: TextInsertionDeps,
): Promise<TextInsertionResult> => {
  if (deps.getFocusedWindow() !== null) {
    return { status: "vellum-focused" };
  }

  // **Asked before the clipboard is touched.** A paste sent where nothing
  // takes text lands on whatever the keystroke happens to mean there, and the
  // application reports nothing back, so this is the only moment the words can
  // still be saved. Withholding leaves the user's clipboard exactly as it was:
  // they have not asked for it to be spent, and what happens to the words
  // instead is the caller's to offer.
  if (!(await deps.frontAppTakesText())) {
    return { status: "no-text-field" };
  }

  // **The application is not hidden to hand focus over.** Nothing here has it:
  // the guard above returns when a Vellum window is focused, and the companion
  // is a non-activating panel, so whatever the user was working in is still
  // frontmost and the keystroke reaches it.
  //
  // Hiding is also unusable on this path even where it would help, because it
  // is all or nothing: the companion goes off the screen with everything else,
  // and a window ordered back un-hides the whole application rather than
  // itself, which pulls Vellum in front of the thing the words just went into.
  const previousClipboard = deps.readClipboardSnapshot();
  deps.writeClipboardText(text);

  let result: TextInsertionResult;
  try {
    await deps.runAppleScript(PASTE_SHORTCUT_SCRIPT);
    result = { status: "inserted" };
  } catch (err) {
    deps.warn("[text-insertion] paste shortcut failed:", err);

    if (isAutomationDeniedError(err)) {
      result = { status: "automation-denied" };
    } else {
      result = { status: "blocked" };
    }
  }

  scheduleClipboardRestore(deps, previousClipboard, text);
  return result;
};

export const typeIntoFrontApp = (text: string): Promise<TextInsertionResult> =>
  typeIntoFrontAppWithDeps(text, defaultDeps);

/**
 * Undo the last edit in the application in front, the way its Edit menu
 * would. The same keystroke path a paste takes, and the same guard: a Vellum
 * window in front means there is no other application to undo in.
 *
 * A paste is one undo step in every editor worth the name, which is what
 * makes this the way to put one dictation in the place of another. What the
 * application actually undoes is its own affair; nothing here can check.
 */
export const undoInFrontAppWithDeps = async (
  deps: Pick<TextInsertionDeps, "getFocusedWindow" | "runAppleScript" | "warn">,
): Promise<TextInsertionResult> => {
  if (deps.getFocusedWindow() !== null) {
    return { status: "vellum-focused" };
  }
  try {
    await deps.runAppleScript(UNDO_SHORTCUT_SCRIPT);
    return { status: "inserted" };
  } catch (err) {
    deps.warn("[text-insertion] undo shortcut failed:", err);
    return isAutomationDeniedError(err)
      ? { status: "automation-denied" }
      : { status: "blocked" };
  }
};

export const undoInFrontApp = (): Promise<TextInsertionResult> =>
  undoInFrontAppWithDeps(defaultDeps);

export const openAutomationSettings = (): Promise<void> =>
  shell.openExternal(AUTOMATION_SETTINGS_URL);

export const installTextInsertionIpc = (): void => {
  handle("vellum:text:insertIntoFrontApp", z.tuple([z.string()]), ([text]) =>
    typeIntoFrontApp(text),
  );
  handle("vellum:text:openAutomationSettings", z.tuple([]), () =>
    openAutomationSettings(),
  );
  handle("vellum:text:undoInFrontApp", z.tuple([]), () => undoInFrontApp());
};
