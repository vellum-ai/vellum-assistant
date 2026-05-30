import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { consoleLifecycleReporter } from "../lifecycle-reporter.js";

describe("consoleLifecycleReporter", () => {
  const originalDesktopApp = process.env.VELLUM_DESKTOP_APP;
  let stdoutWriteSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutWriteSpy = spyOn(process.stdout, "write").mockImplementation(
      () => true,
    );
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    if (originalDesktopApp === undefined) {
      delete process.env.VELLUM_DESKTOP_APP;
    } else {
      process.env.VELLUM_DESKTOP_APP = originalDesktopApp;
    }
  });

  test("routes log/warn/error to the matching console methods", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    consoleLifecycleReporter.log("hello");
    consoleLifecycleReporter.warn("careful");
    consoleLifecycleReporter.error("boom");

    expect(logSpy).toHaveBeenCalledWith("hello");
    expect(warnSpy).toHaveBeenCalledWith("careful");
    expect(errorSpy).toHaveBeenCalledWith("boom");

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("emits the HATCH_PROGRESS stdout contract under VELLUM_DESKTOP_APP", () => {
    process.env.VELLUM_DESKTOP_APP = "1";

    consoleLifecycleReporter.progress(3, 6, "Starting assistant...");

    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      `HATCH_PROGRESS:${JSON.stringify({ step: 3, total: 6, label: "Starting assistant..." })}\n`,
    );
  });

  test("suppresses progress output when not running under the desktop app", () => {
    delete process.env.VELLUM_DESKTOP_APP;

    consoleLifecycleReporter.progress(1, 6, "Allocating resources...");

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
  });
});
