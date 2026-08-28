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

  test("packaged daemon as argv0", () => {
    expect(isDaemonCommand("/Applications/Vellum/vellum-daemon")).toBe(true);
  });

  // The ordinary Windows install path contains a space, so splitting on
  // whitespace before honouring quotes would yield argv0 "Program" and make
  // the packaged daemon invisible to the recovery path this predicate serves.
  test("packaged Windows daemon under an install path containing spaces", () => {
    expect(
      isDaemonCommand(
        '"C:\\Program Files\\Vellum\\resources\\cli-runtime\\vellum-daemon.exe"',
      ),
    ).toBe(true);
    expect(
      isDaemonCommand(
        '"C:\\Program Files\\Vellum\\resources\\cli-runtime\\vellum-daemon.exe" --serve',
      ),
    ).toBe(true);
  });

  test("quoted bun entry-script argument under a path containing spaces", () => {
    expect(
      isDaemonCommand(
        '"C:\\Program Files\\bun\\bun.exe" run "C:\\Program Files\\Vellum\\src\\daemon\\main.ts"',
      ),
    ).toBe(true);
  });

  // POSIX joins argv with spaces, so an entry path containing a space arrives
  // pre-split; the tail token still carries the entry, which is what matches.
  test("unquoted POSIX entry path containing a space", () => {
    expect(
      isDaemonCommand(
        "/home/mary/.bun/bin/bun run /home/Mary Jane/runtime/src/daemon/main.ts",
      ),
    ).toBe(true);
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
