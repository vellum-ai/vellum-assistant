import { beforeEach, describe, expect, test } from "bun:test";

import { runPlatform, setupPlatformIpcMock } from "./helpers.js";

const ipc = setupPlatformIpcMock();

describe("assistant platform credits", () => {
  beforeEach(() => {
    ipc.calls = [];
    ipc.response = {
      ok: true,
      result: {
        remaining: 42.17,
        settled: 50,
        pending: 7.83,
        unit: "USD",
        stale: false,
        as_of: "2026-07-06T00:00:00.000Z",
      },
    };
  });

  test("calls platform_credits and emits balance JSON with --json", async () => {
    const out = await runPlatform(["credits", "--json"]);

    expect(ipc.calls[0][0]).toBe("platform_credits");

    const parsed = JSON.parse(out.join(""));
    expect(parsed.remaining).toBe(42.17);
    expect(parsed.settled).toBe(50);
    expect(parsed.pending).toBe(7.83);
    expect(parsed.unit).toBe("USD");
    expect(parsed.stale).toBe(false);
  });

  test("plain text mode does not emit JSON to stdout", async () => {
    const out = await runPlatform(["credits"]);

    // Plain-text mode logs via log.info; verify writeOutput (JSON) was NOT called
    expect(() => JSON.parse(out.join("").trim())).toThrow();
  });
});
