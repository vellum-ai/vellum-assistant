import { describe, expect, test } from "bun:test";

import { isDaemonCommand } from "../worker-ownership.js";

// This predicate authorises an irreversible signal in killStaleDaemon, so it
// judges argv shape rather than substring. The negative cases are the
// collision cli/src/lib/orphan-detection.test.ts already pins as something we
// must not claim.
describe("isDaemonCommand", () => {
  test("source daemon: bun with the entry script as an argument", () => {
    expect(
      isDaemonCommand(
        "bun run /app/runtime/0.11.7/node_modules/@vellumai/assistant/src/daemon/main.ts",
      ),
    ).toBe(true);
  });

  test("packaged daemon as argv0, including a quoted Windows path", () => {
    expect(isDaemonCommand("/Applications/Vellum/vellum-daemon")).toBe(true);
    expect(isDaemonCommand('"C:\\App\\vellum-daemon.exe" --serve')).toBe(true);
  });

  // process.title rewrites the source daemon's argv on Linux.
  test("a daemon that renamed its own process title", () => {
    expect(isDaemonCommand("vellum-daemon")).toBe(true);
  });

  test("unrelated service whose argv merely contains a daemon/main path", () => {
    expect(isDaemonCommand("node /opt/unrelated-service/daemon/main.ts")).toBe(
      false,
    );
  });

  test("an editor or tool holding a recycled PID", () => {
    expect(isDaemonCommand("vim /app/runtime/0.11.7/src/daemon/main.ts")).toBe(
      false,
    );
  });

  test("unreadable or empty command line", () => {
    expect(isDaemonCommand(null)).toBe(false);
    expect(isDaemonCommand("")).toBe(false);
  });
});
