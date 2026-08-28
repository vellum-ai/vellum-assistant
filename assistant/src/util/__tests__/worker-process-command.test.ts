import { describe, expect, test } from "bun:test";

import {
  resolveWorkerCommand,
  workerKindSignature,
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

describe("workerKindSignature", () => {
  const schedule = new URL(
    "file:////app/runtime/0.11.7/src/schedule/worker.ts",
  );
  const source = {
    platform: "darwin" as const,
    execPath: "/runtime/bun",
    executableExists: () => false,
  };

  test("is the same for a worker of this kind from any install", () => {
    const previous = new URL(
      "file:////app/runtime/0.10.11/src/schedule/worker.ts",
    );
    expect(workerKindSignature(schedule, "schedule", source)).toBe(
      workerKindSignature(previous, "schedule", source),
    );
  });

  test("distinguishes one worker kind from another", () => {
    const monitoring = new URL(
      "file:////app/runtime/0.11.7/src/monitoring/worker.ts",
    );
    expect(workerKindSignature(schedule, "schedule", source)).not.toBe(
      workerKindSignature(monitoring, "monitoring", source),
    );
  });

  // The signature only guards against signalling a recycled PID, so it has to
  // be specific enough that an unrelated program running its own worker.ts
  // never matches.
  test("does not match an unrelated program running some other worker.ts", () => {
    const signature = workerKindSignature(schedule, "schedule", source);
    expect("bun run /home/dev/side-project/worker.ts").not.toContain(signature);
    expect("node /srv/queue/src/jobs/worker.ts").not.toContain(signature);
  });

  test("matches the same worker from a previous install", () => {
    const signature = workerKindSignature(schedule, "schedule", source);
    expect(
      "bun --smol run /app/runtime/0.10.11/src/schedule/worker.ts",
    ).toContain(signature);
  });

  test("is the packaged executable name inside a packaged runtime", () => {
    expect(
      workerKindSignature(schedule, "schedule", {
        platform: "win32",
        execPath: "/runtime/vellum-daemon.exe",
        executableExists: () => true,
      }),
    ).toBe("vellum-worker");
  });
});
