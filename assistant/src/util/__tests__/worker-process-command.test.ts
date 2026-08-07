import { describe, expect, test } from "bun:test";

import { resolveWorkerCommand } from "../worker-process.js";

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
