import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { openInHostBrowser } from "./open-browser.js";

describe("openInHostBrowser", () => {
  test("launches the default browser directly on macOS", () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: unknown;
    }> = [];
    let unrefCalled = false;
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => {
      unrefCalled = true;
      return child;
    };
    const spawnImpl = ((
      command: string,
      args: readonly string[],
      options: unknown,
    ) => {
      calls.push({ command, args, options });
      return child;
    }) as typeof spawn;

    openInHostBrowser("https://example.com/auth", {
      platform: "darwin",
      spawnImpl,
    });

    expect(calls).toEqual([
      {
        command: "open",
        args: ["https://example.com/auth"],
        options: { detached: true, stdio: "ignore" },
      },
    ]);
    expect(unrefCalled).toBe(true);
  });

  test("emits a host-client signal on Windows", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "open-browser-test-"));
    try {
      openInHostBrowser("https://example.com/auth", {
        platform: "win32",
        workspaceDir,
      });

      expect(
        JSON.parse(
          readFileSync(join(workspaceDir, "signals", "emit-event"), "utf8"),
        ),
      ).toEqual({
        type: "open_url",
        url: "https://example.com/auth",
      });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
