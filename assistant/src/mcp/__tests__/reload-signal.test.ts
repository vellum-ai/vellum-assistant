/**
 * The MCP reload signal, the channel that tells the daemon's child processes
 * their MCP server set moved.
 *
 * They hold their own connections to the same servers and have no config
 * watcher of their own, so without this they keep serving the set as it stood
 * when they started: a server the config has since disabled stays callable
 * there long after the daemon dropped it.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { getSignalsDir } from "../../util/platform.js";
import { MCP_RELOAD_SIGNAL_FILE, signalMcpReloaded } from "../reload-signal.js";

const signalPath = () => join(getSignalsDir(), MCP_RELOAD_SIGNAL_FILE);

beforeEach(() => {
  rmSync(signalPath(), { force: true });
});

describe("signalMcpReloaded", () => {
  test("writes the signal file", () => {
    signalMcpReloaded();

    expect(existsSync(signalPath())).toBe(true);
    expect(Number(readFileSync(signalPath(), "utf8"))).toBeGreaterThan(0);
  });

  test("creates the signals directory when it is absent", () => {
    rmSync(getSignalsDir(), { recursive: true, force: true });

    signalMcpReloaded();

    expect(existsSync(signalPath())).toBe(true);
  });

  test("rewrites in place, so a second reload is a fresh event", () => {
    mkdirSync(getSignalsDir(), { recursive: true });
    signalMcpReloaded();
    const first = readFileSync(signalPath(), "utf8");

    const until = Date.now() + 2;
    while (Date.now() < until) {
      /* let the clock move so the two writes differ */
    }
    signalMcpReloaded();

    expect(
      readFileSync(signalPath(), "utf8"),
      "Readers react to the write rather than consuming the file, so the " +
        "content has to change for a second reload to register.",
    ).not.toBe(first);
  });
});
