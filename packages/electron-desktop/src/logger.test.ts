import { afterAll, describe, expect, mock, test } from "bun:test";

/**
 * `electron-log/main` stub. Only the surface the logger module configures is
 * modelled; `transports.console.level` is the flag the stdio guard flips.
 */
const logStub = {
  initialize: mock((_options: { preload: boolean }) => {}),
  transports: {
    console: { level: "silly" as string | false },
    file: {
      maxSize: 0,
      fileName: "",
      format: "",
      getFile: () => ({ path: "/tmp/vellum.log" }),
    },
  },
};

mock.module("electron-log/main", () => ({ default: logStub }));

const listenersBefore = {
  stdout: process.stdout.listenerCount("error"),
  stderr: process.stderr.listenerCount("error"),
};

const { getLogFilePaths } = await import("./logger");

const installed = {
  stdout: process.stdout.listeners("error").slice(listenersBefore.stdout) as ((
    error: Error,
  ) => void)[],
  stderr: process.stderr.listeners("error").slice(listenersBefore.stderr) as ((
    error: Error,
  ) => void)[],
};

afterAll(() => {
  for (const listener of installed.stdout) {
    process.stdout.off("error", listener);
  }
  for (const listener of installed.stderr) {
    process.stderr.off("error", listener);
  }
});

function ioError(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code });
}

/** Read untyped: `LogLevel | false` narrows `toBe` to its string overload. */
const consoleTransportLevel = (): unknown => logStub.transports.console.level;

describe("main-process logger", () => {
  test("guards both stdio streams with exactly one listener each", () => {
    // A stream left unguarded turns its next write failure into an uncaught
    // exception, so the count, not just the presence of a listener, is the
    // invariant.
    expect(installed.stdout).toHaveLength(1);
    expect(installed.stderr).toHaveLength(1);
  });

  test("a stderr write failure does not escape as an uncaught error", () => {
    // `emit("error")` throws when the stream carries no listener, which is
    // exactly how EIO takes the main process down.
    expect(() => process.stderr.emit("error", ioError("EIO"))).not.toThrow();
  });

  test("a stdout write failure does not escape as an uncaught error", () => {
    expect(() => process.stdout.emit("error", ioError("EPIPE"))).not.toThrow();
  });

  test("a write failure drops the console transport", () => {
    logStub.transports.console.level = "silly";
    process.stderr.emit("error", ioError("EIO"));
    expect(consoleTransportLevel()).toBe(false);
  });

  test("the file transport stays configured as the surviving sink", () => {
    expect(logStub.transports.file.fileName).toBe("vellum.log");
    expect(logStub.transports.file.maxSize).toBe(10 * 1024 * 1024);
    expect(getLogFilePaths()).toEqual(["/tmp/vellum.log"]);
  });
});
