import { describe, expect, test } from "bun:test";

import { isValidAccelerator } from "./accelerator";

describe("isValidAccelerator", () => {
  test("accepts a bare single-character key", () => {
    expect(isValidAccelerator("A")).toBe(true);
    expect(isValidAccelerator("5")).toBe(true);
  });

  test("accepts modifiers followed by a key", () => {
    expect(isValidAccelerator("CmdOrCtrl+N")).toBe(true);
    expect(isValidAccelerator("CmdOrCtrl+Shift+N")).toBe(true);
    expect(isValidAccelerator("Command+Alt+Shift+K")).toBe(true);
  });

  test("is case-insensitive for modifiers and named keys", () => {
    expect(isValidAccelerator("cmdorctrl+up")).toBe(true);
    expect(isValidAccelerator("CMDORCTRL+SHIFT+RIGHT")).toBe(true);
  });

  test("accepts named keys, function keys, and numpad keys", () => {
    expect(isValidAccelerator("CmdOrCtrl+Up")).toBe(true);
    expect(isValidAccelerator("F11")).toBe(true);
    expect(isValidAccelerator("CmdOrCtrl+num5")).toBe(true);
    expect(isValidAccelerator("Space")).toBe(true);
  });

  test("accepts punctuation keys and the plus key", () => {
    expect(isValidAccelerator("CmdOrCtrl+\\")).toBe(true);
    expect(isValidAccelerator("CmdOrCtrl+,")).toBe(true);
    // The plus key by its named code, and by a trailing "+" after a modifier.
    expect(isValidAccelerator("CmdOrCtrl+Plus")).toBe(true);
    expect(isValidAccelerator("CmdOrCtrl+")).toBe(true);
  });

  test("rejects an empty string", () => {
    expect(isValidAccelerator("")).toBe(false);
  });

  test("rejects a modifier with no key code", () => {
    expect(isValidAccelerator("CmdOrCtrl")).toBe(false);
    expect(isValidAccelerator("CmdOrCtrl+Shift")).toBe(false);
  });

  test("rejects more than one key code", () => {
    expect(isValidAccelerator("A+B")).toBe(false);
    expect(isValidAccelerator("CmdOrCtrl+A+B")).toBe(false);
  });

  test("rejects duplicate modifiers", () => {
    expect(isValidAccelerator("Shift+Shift+A")).toBe(false);
    expect(isValidAccelerator("CmdOrCtrl+cmdorctrl+A")).toBe(false);
  });

  test("rejects unknown tokens and empty segments", () => {
    expect(isValidAccelerator("Hyper+A")).toBe(false);
    expect(isValidAccelerator("CmdOrCtrl++A")).toBe(false);
    expect(isValidAccelerator("+A")).toBe(false);
  });
});
