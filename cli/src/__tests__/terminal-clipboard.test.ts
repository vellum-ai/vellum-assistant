import { describe, expect, test } from "bun:test";

import {
  copyTextToClipboard,
  type ClipboardWriter,
  type CommandRunner,
} from "../lib/terminal-clipboard.js";

describe("terminal clipboard", () => {
  test("copies with OSC 52 when stdout is an interactive terminal", async () => {
    let written = "";
    const stdout: ClipboardWriter = {
      isTTY: true,
      write: (chunk) => {
        written += chunk;
      },
    };

    const result = await copyTextToClipboard("hello", {
      stdout,
      env: { TERM: "xterm-256color" },
      platform: "linux",
    });

    expect(result).toEqual({ copied: true, method: "osc52" });
    expect(written).toBe(
      `\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`,
    );
  });

  test("falls back to pbcopy on macOS", async () => {
    let captured:
      | { command: string; args: string[]; input: string }
      | undefined;
    const runCommand: CommandRunner = async (command, args, input) => {
      captured = { command, args, input };
      return { success: true };
    };

    const result = await copyTextToClipboard("hello", {
      stdout: { isTTY: false, write: () => {} },
      env: { TERM: "dumb" },
      platform: "darwin",
      runCommand,
    });

    expect(result).toEqual({ copied: true, method: "pbcopy" });
    expect(captured).toEqual({
      command: "pbcopy",
      args: [],
      input: "hello",
    });
  });

  test("reports unsupported terminals when no strategy works", async () => {
    const result = await copyTextToClipboard("hello", {
      stdout: { isTTY: false, write: () => {} },
      env: { TERM: "dumb" },
      platform: "linux",
    });

    expect(result).toEqual({ copied: false, reason: "unsupported" });
  });

  test("reports empty input without writing", async () => {
    let wrote = false;
    const result = await copyTextToClipboard("", {
      stdout: {
        isTTY: true,
        write: () => {
          wrote = true;
        },
      },
      env: { TERM: "xterm-256color" },
      platform: "linux",
    });

    expect(result).toEqual({ copied: false, reason: "empty" });
    expect(wrote).toBe(false);
  });
});
