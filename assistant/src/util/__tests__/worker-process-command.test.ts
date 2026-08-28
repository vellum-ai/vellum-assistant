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
  const matches = (command: string, signature: readonly string[]): boolean =>
    signature.every((part) => command.includes(part));

  test("does not match an unrelated program running some other worker.ts", () => {
    const signature = workerKindSignature(schedule, "schedule", source);
    expect(matches("bun run /home/dev/side-project/worker.ts", signature)).toBe(
      false,
    );
    expect(matches("node /srv/queue/src/jobs/worker.ts", signature)).toBe(
      false,
    );
  });

  test("matches the same worker from a previous install", () => {
    const signature = workerKindSignature(schedule, "schedule", source);
    expect(
      matches(
        "bun --smol run /app/runtime/0.10.11/src/schedule/worker.ts",
        signature,
      ),
    ).toBe(true);
  });

  const packaged = {
    platform: "win32" as const,
    execPath: "/runtime/vellum-daemon.exe",
    executableExists: () => true,
  };

  // Every packaged worker runs one executable and is told apart by the
  // subcommand, so the executable alone must not identify a worker: one
  // worker's slot would otherwise reclaim another's process.
  test("distinguishes packaged worker kinds sharing one executable", () => {
    const scheduleSig = workerKindSignature(schedule, "schedule", packaged);
    expect(matches('"C:/App/vellum-worker.exe" schedule', scheduleSig)).toBe(
      true,
    );
    expect(matches('"C:/App/vellum-worker.exe" monitoring', scheduleSig)).toBe(
      false,
    );
  });

  test("matches a packaged worker from a previous install", () => {
    const scheduleSig = workerKindSignature(schedule, "schedule", packaged);
    expect(matches('"C:/Prev/vellum-worker.exe" schedule', scheduleSig)).toBe(
      true,
    );
  });
});
