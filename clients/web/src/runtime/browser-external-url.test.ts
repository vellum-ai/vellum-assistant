import { afterEach, expect, mock, test } from "bun:test";
import * as capacitorCore from "@capacitor/core";

const nativeBrowserOpen = mock(async () => {
  throw new Error("plugin unavailable");
});

mock.module("@capacitor/core", () => ({
  ...capacitorCore,
  Capacitor: {
    ...capacitorCore.Capacitor,
    isNativePlatform: () => true,
  },
}));
mock.module("@capacitor/browser", () => ({
  Browser: {
    open: nativeBrowserOpen,
  },
}));
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => false,
}));

const { openExternalUrl } = await import("./browser");
const originalWindowOpen = window.open;

afterEach(() => {
  window.open = originalWindowOpen;
  nativeBrowserOpen.mockClear();
});

test("native browser fallback prevents the destination from receiving an opener", async () => {
  const windowOpen = mock(() => null);
  window.open = windowOpen as typeof window.open;

  await openExternalUrl("https://mcp.example.com/authorize");

  expect(nativeBrowserOpen).toHaveBeenCalledTimes(1);
  expect(windowOpen).toHaveBeenCalledWith(
    "https://mcp.example.com/authorize",
    "_blank",
    "noopener,noreferrer",
  );
});
