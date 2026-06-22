import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// `resolveAllowedOrigin` branches on `app.isPackaged`, so the electron
// stub exposes it as a mutable getter the tests flip per case.
const appState = { isPackaged: false };
mock.module("electron", () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged;
    },
  },
}));

const { isAllowedOrigin, resolveAllowedOrigin } = await import("./app-origin");

const ORIGINAL_DEV_URL = process.env.VELLUM_DEV_URL;

beforeEach(() => {
  appState.isPackaged = false;
  delete process.env.VELLUM_DEV_URL;
});

afterEach(() => {
  if (ORIGINAL_DEV_URL === undefined) {
    delete process.env.VELLUM_DEV_URL;
  } else {
    process.env.VELLUM_DEV_URL = ORIGINAL_DEV_URL;
  }
});

describe("resolveAllowedOrigin", () => {
  test("packaged builds resolve to the app://vellum.ai tuple origin", () => {
    appState.isPackaged = true;
    expect(resolveAllowedOrigin()).toEqual({
      protocol: "app:",
      host: "vellum.ai",
    });
  });

  test("dev falls back to the local Vite origin when VELLUM_DEV_URL is unset", () => {
    expect(resolveAllowedOrigin()).toEqual({
      protocol: "http:",
      host: "localhost:5173",
    });
  });

  test("dev honors VELLUM_DEV_URL, including a non-default port in the host", () => {
    process.env.VELLUM_DEV_URL = "http://localhost:3000/assistant";
    expect(resolveAllowedOrigin()).toEqual({
      protocol: "http:",
      host: "localhost:3000",
    });
  });

  test("the packaged-vs-dev decision is read at call time, not cached", () => {
    expect(resolveAllowedOrigin().protocol).toBe("http:");
    appState.isPackaged = true;
    expect(resolveAllowedOrigin()).toEqual({
      protocol: "app:",
      host: "vellum.ai",
    });
  });
});

describe("isAllowedOrigin", () => {
  const prod = { protocol: "app:", host: "vellum.ai" };
  const dev = { protocol: "http:", host: "localhost:5173" };

  test("accepts the exact packaged origin string a frame reports", () => {
    expect(isAllowedOrigin("app://vellum.ai", prod)).toBe(true);
  });

  test("accepts an already-parsed URL navigation target", () => {
    expect(isAllowedOrigin(new URL("http://localhost:5173/assistant"), dev)).toBe(
      true,
    );
  });

  test("rejects a foreign host on the right protocol", () => {
    expect(isAllowedOrigin("https://evil.example.com", prod)).toBe(false);
    expect(isAllowedOrigin("http://localhost:9999", dev)).toBe(false);
  });

  test("rejects a protocol mismatch on the right host", () => {
    expect(isAllowedOrigin("https://vellum.ai", prod)).toBe(false);
  });

  test("rejects null, undefined, empty, and unparseable origins", () => {
    expect(isAllowedOrigin(null, prod)).toBe(false);
    expect(isAllowedOrigin(undefined, prod)).toBe(false);
    expect(isAllowedOrigin("", prod)).toBe(false);
    expect(isAllowedOrigin("not a url", prod)).toBe(false);
  });

  test("rejects the opaque 'null' origin a sandboxed/foreign frame reports", () => {
    expect(isAllowedOrigin("null", prod)).toBe(false);
  });
});
