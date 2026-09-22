import { afterEach, expect, test } from "bun:test";

import type { HotkeySelectionResult } from "@vellumai/ipc-contract";

import { readFrontSelection } from "./hotkey";

const originalBridge = window.vellum;

afterEach(() => {
  window.vellum = originalBridge;
});

function installReader(read: () => Promise<HotkeySelectionResult>): void {
  window.vellum = {
    platform: "electron",
    helper: { hotkey: { readFrontSelection: read } },
  } as unknown as Window["vellum"];
}

test("preserves a confirmed empty selection", async () => {
  installReader(async () => null);
  expect(await readFrontSelection()).toBeNull();
});

test("preserves an editable selection", async () => {
  const selection = { text: "Example passage", truncated: false, editable: true };
  installReader(async () => selection);
  expect(await readFrontSelection()).toEqual(selection);
});

test("preserves a native capture failure", async () => {
  installReader(async () => ({ unavailable: true }));
  expect(await readFrontSelection()).toEqual({ unavailable: true });
});

test("does not turn an IPC failure into an empty selection", async () => {
  installReader(async () => { throw new Error("bridge unavailable"); });
  expect(await readFrontSelection()).toEqual({ unavailable: true });
});

test("keeps dictation available on hosts without selection capture", async () => {
  window.vellum = undefined;
  expect(await readFrontSelection()).toBeNull();
});
