import { describe, expect, mock, test } from "bun:test";

const logStub = {
  initialize: mock((_options: { preload: boolean }) => {}),
  transports: {
    console: { level: "silly" as unknown },
    file: {
      maxSize: 0,
      fileName: "",
      format: "",
      getFile: () => ({ path: "/tmp/vellum.log" }),
    },
  },
};

mock.module("electron-log/main", () => ({ default: logStub }));

const errorListenersBefore = {
  stdout: process.stdout.listenerCount("error"),
  stderr: process.stderr.listenerCount("error"),
};

const { getLogFilePaths } = await import("./app-logger");

describe("main-process logger", () => {
  test("guards both stdio streams with exactly one listener each", () => {
    // An unguarded stream is the defect, so the count is the invariant.
    expect(process.stdout.listenerCount("error")).toBe(
      errorListenersBefore.stdout + 1,
    );
    expect(process.stderr.listenerCount("error")).toBe(
      errorListenersBefore.stderr + 1,
    );
  });

  test("a stderr write failure does not escape as an uncaught error", () => {
    // `emit("error")` on a listener-less stream throws, which is exactly how
    // a dead descriptor reaches the uncaught-exception handler.
    expect(() =>
      process.stderr.emit("error", new Error("write EIO")),
    ).not.toThrow();
  });

  test("a stdout write failure does not escape as an uncaught error", () => {
    expect(() =>
      process.stdout.emit("error", new Error("write EPIPE")),
    ).not.toThrow();
  });

  test("a write failure drops the console transport", () => {
    logStub.transports.console.level = "silly";
    process.stderr.emit("error", new Error("write EIO"));
    expect(logStub.transports.console.level).toBe(false);
  });

  test("the file transport stays configured as the surviving sink", () => {
    expect(logStub.transports.file.fileName).toBe("vellum.log");
    expect(logStub.transports.file.maxSize).toBe(10 * 1024 * 1024);
    expect(getLogFilePaths()).toEqual(["/tmp/vellum.log"]);
  });
});
