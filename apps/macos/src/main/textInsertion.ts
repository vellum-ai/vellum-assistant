import { BrowserWindow, app, clipboard, shell } from "electron";
import { z } from "zod";

import { runAppleScript } from "./appleScriptExecutor";
import { handle } from "./ipc";
import log from "./logger";

const FOCUS_RETURN_DELAY_MS = 80;
const CLIPBOARD_RESTORE_DELAY_MS = 500;
const PASTE_SHORTCUT_SCRIPT =
  'tell application "System Events" to keystroke "v" using command down';

const AUTOMATION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

export type TextInsertionResult =
  | { status: "inserted" }
  | { status: "vellum-focused" }
  | { status: "automation-denied" }
  | { status: "blocked" };

export type TextInsertionDeps = {
  getFocusedWindow: () => BrowserWindow | null;
  readClipboardText: () => string;
  writeClipboardText: (text: string) => void;
  hideApp: () => void;
  runAppleScript: (script: string) => Promise<unknown>;
  warn: (...args: unknown[]) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  sleep: (ms: number) => Promise<void>;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const defaultDeps: TextInsertionDeps = {
  getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
  readClipboardText: () => clipboard.readText(),
  writeClipboardText: (text) => clipboard.writeText(text),
  hideApp: () => app.hide(),
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
  previousText: string,
  insertedText: string,
): void => {
  deps.setTimeout(() => {
    if (deps.readClipboardText() === insertedText) {
      deps.writeClipboardText(previousText);
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

  const previousText = deps.readClipboardText();
  deps.writeClipboardText(text);
  deps.hideApp();
  await deps.sleep(FOCUS_RETURN_DELAY_MS);

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

  scheduleClipboardRestore(deps, previousText, text);
  return result;
};

export const typeIntoFrontApp = (text: string): Promise<TextInsertionResult> =>
  typeIntoFrontAppWithDeps(text, defaultDeps);

export const openAutomationSettings = (): Promise<void> =>
  shell.openExternal(AUTOMATION_SETTINGS_URL);

export const installTextInsertionIpc = (): void => {
  handle("vellum:text:insertIntoFrontApp", z.tuple([z.string()]), ([text]) =>
    typeIntoFrontApp(text),
  );
  handle("vellum:text:openAutomationSettings", z.tuple([]), () =>
    openAutomationSettings(),
  );
};
