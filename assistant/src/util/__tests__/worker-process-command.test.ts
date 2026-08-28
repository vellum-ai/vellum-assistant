import { describe, expect, test } from "bun:test";

import {
  classifyWorkerRuntime,
  resolveWorkerCommand,
  workerInstallPath,
} from "../worker-process.js";

const entry = new URL("file:///source/monitoring/worker.ts");

describe("resolveWorkerCommand", () => {
  test("uses the packaged Windows worker executable when present", () => {
    expect(
      resolveWorkerCommand(entry, "monitoring", {
        platform: "win32",
        execPath: "/runtime/vellum-daemon.exe",
        executableExists: () => true,
      }),
    ).toEqual(["/runtime/vellum-worker.exe", "monitoring"]);
  });

  test("routes integrity checks through the packaged worker", () => {
    expect(
      resolveWorkerCommand(entry, "db-integrity", {
        platform: "win32",
        execPath: "/runtime/vellum-worker.exe",
        executableExists: () => true,
      }),
    ).toEqual(["/runtime/vellum-worker.exe", "db-integrity"]);
  });

  test("falls back to the source entry outside a packaged runtime", () => {
    expect(
      resolveWorkerCommand(entry, "monitoring", {
        platform: "win32",
        execPath: "/runtime/vellum-daemon.exe",
        executableExists: () => false,
      }),
    ).toEqual(["bun", "--smol", "run", "/source/monitoring/worker.ts"]);
  });
});

describe("workerInstallPath", () => {
  test("is the packaged executable inside a packaged Windows runtime", () => {
    expect(
      workerInstallPath(entry, "monitoring", {
        platform: "win32",
        execPath: "/runtime/vellum-daemon.exe",
        executableExists: () => true,
      }),
    ).toBe("/runtime/vellum-worker.exe");
  });

  test("is the source entry script otherwise", () => {
    expect(
      workerInstallPath(entry, "monitoring", {
        platform: "darwin",
        execPath: "/runtime/bun",
        executableExists: () => false,
      }),
    ).toBe("/source/monitoring/worker.ts");
  });
});

describe("classifyWorkerRuntime", () => {
  const installed =
    "/Users/x/.v/runtime/0.11.7/node_modules/@vellumai/assistant/src/schedule/worker.ts";
  const previous =
    "/Users/x/.v/runtime/0.10.11/node_modules/@vellumai/assistant/src/schedule/worker.ts";

  test("reuses a worker spawned from this install", () => {
    expect(
      classifyWorkerRuntime(`bun --smol run ${installed}`, installed),
    ).toBe("current");
  });

  test("flags a worker left behind by a previous runtime version", () => {
    expect(classifyWorkerRuntime(`bun --smol run ${previous}`, installed)).toBe(
      "foreign-runtime",
    );
  });

  test("flags a packaged worker from another install", () => {
    expect(
      classifyWorkerRuntime(
        "C:\\Prev\\vellum-worker.exe schedule",
        "C:\\Current\\vellum-worker.exe",
      ),
    ).toBe("foreign-runtime");
  });

  test("reuses a packaged worker from this install", () => {
    expect(
      classifyWorkerRuntime(
        "C:\\Current\\vellum-worker.exe schedule",
        "C:\\Current\\vellum-worker.exe",
      ),
    ).toBe("current");
  });

  // The kill path keys off this: anything not recognisable as one of our
  // workers may be an unrelated process that inherited a recycled PID.
  test("leaves an unrelated process that reused the PID alone", () => {
    expect(classifyWorkerRuntime("/usr/bin/postgres -D /data", installed)).toBe(
      "unknown",
    );
  });

  test("leaves a process whose command line could not be read alone", () => {
    expect(classifyWorkerRuntime(null, installed)).toBe("unknown");
  });

  // "worker.ts" as a bare substring of some other program's arguments is not
  // a worker; the separator before it is what makes it a path.
  test("does not treat an incidental worker.ts mention as a worker", () => {
    expect(
      classifyWorkerRuntime("rg --files-with-matches worker.tsx", installed),
    ).toBe("unknown");
  });
});
