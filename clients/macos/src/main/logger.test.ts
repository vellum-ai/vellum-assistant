import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const appState = { isPackaged: true };

mock.module("electron", () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged;
    },
  },
}));

const STOCK_DIR = "/Users/someone/Library/Logs/@vellumai/macos";
const pathVariables = { libraryDefaultDir: STOCK_DIR };

const fileTransport = {
  fileName: "vellum.log",
  resolvePathFn: (vars: { libraryDefaultDir: string }): string =>
    `${vars.libraryDefaultDir}/vellum.log`,
  getFile: () => ({ path: fileTransport.resolvePathFn(pathVariables) }),
};

mock.module("@vellumai/electron-desktop/app-logger", () => ({
  default: {
    transports: { file: fileTransport },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  getLogFilePaths: () => [fileTransport.getFile().path],
}));

// The build define is absent under bun test; a staging build is the case that
// interleaved with production in the shared file.
const globals = globalThis as { __VELLUM_ENVIRONMENT__?: string };
globals.__VELLUM_ENVIRONMENT__ = "staging";

const { getLogFilePaths, resolveLogDir } = await import("./logger");

afterAll(() => {
  delete globals.__VELLUM_ENVIRONMENT__;
});

beforeEach(() => {
  appState.isPackaged = true;
});

describe("resolveLogDir", () => {
  test("production keeps the stock directory", () => {
    expect(resolveLogDir(STOCK_DIR, "production", true)).toBe(STOCK_DIR);
  });

  test("other packaged channels get the userData-style suffix", () => {
    expect(resolveLogDir(STOCK_DIR, "dev", true)).toBe(`${STOCK_DIR}-dev`);
    expect(resolveLogDir(STOCK_DIR, "staging", true)).toBe(
      `${STOCK_DIR}-staging`,
    );
  });

  test("an unpackaged build keeps the stock directory whatever its channel", () => {
    expect(resolveLogDir(STOCK_DIR, "local", false)).toBe(STOCK_DIR);
  });
});

describe("the file transport", () => {
  test("writes the packaged channel's own file", () => {
    expect(fileTransport.resolvePathFn(pathVariables)).toBe(
      `${STOCK_DIR}-staging/vellum.log`,
    );
  });

  test("the diagnostics reader follows the same resolution", () => {
    expect(getLogFilePaths()).toEqual([`${STOCK_DIR}-staging/vellum.log`]);

    appState.isPackaged = false;
    expect(getLogFilePaths()).toEqual([`${STOCK_DIR}/vellum.log`]);
  });
});
