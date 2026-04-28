import { describe, expect, test } from "bun:test";

import {
  parseSentinelOutput,
  stripAnsi,
} from "../terminal-session.js";

const START = "__VELLUM_EXEC_START_1234__";
const END = "__VELLUM_EXEC_END_1234__";

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  test("removes SGR color codes", () => {
    expect(stripAnsi("\x1b[32mINFO\x1b[39m hello")).toBe("INFO hello");
  });

  test("removes OSC title sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07prompt$ ")).toBe("prompt$ ");
  });

  test("removes carriage returns", () => {
    expect(stripAnsi("line1\r\nline2\r\n")).toBe("line1\nline2\n");
  });

  test("removes bracket-paste mode escapes", () => {
    expect(stripAnsi("\x1b[?2004hroot$ ")).toBe("root$ ");
  });

  test("removes charset designator sequences", () => {
    expect(stripAnsi("\x1b(Bhello")).toBe("hello");
  });

  test("passes through plain text unchanged", () => {
    expect(stripAnsi("just plain text")).toBe("just plain text");
  });

  test("handles mixed ANSI sequences", () => {
    const raw =
      "\x1b[?2004hroot:/workspace$ \r\x1b[K\rroot:/workspace$ echo hello\r\nhello\r\n";
    const clean = stripAnsi(raw);
    expect(clean).not.toContain("\x1b");
    expect(clean).not.toContain("\r");
    expect(clean).toContain("hello");
  });
});

// ---------------------------------------------------------------------------
// parseSentinelOutput
// ---------------------------------------------------------------------------

describe("parseSentinelOutput", () => {
  test("extracts output between sentinels", () => {
    const cleaned = [
      `echo '${START}'; ls; echo '${END}'; echo '__VELLUM_EXIT_'$__ec`,
      START,
      "file1.txt",
      "file2.txt",
      END,
      "__VELLUM_EXIT_0",
    ].join("\n");

    const result = parseSentinelOutput(cleaned, START, END);
    expect(result.output).toBe("file1.txt\nfile2.txt");
    expect(result.exitCode).toBe(0);
  });

  test("extracts non-zero exit code", () => {
    const cleaned = [
      `echo '${START}'; false; echo '${END}'; echo '__VELLUM_EXIT_'$__ec`,
      START,
      END,
      "__VELLUM_EXIT_1",
    ].join("\n");

    const result = parseSentinelOutput(cleaned, START, END);
    expect(result.output).toBe("");
    expect(result.exitCode).toBe(1);
  });

  test("handles exit code 127 (command not found)", () => {
    const cleaned = [
      START,
      "bash: nosuchcmd: command not found",
      END,
      "__VELLUM_EXIT_127",
    ].join("\n");

    const result = parseSentinelOutput(cleaned, START, END);
    expect(result.output).toBe("bash: nosuchcmd: command not found");
    expect(result.exitCode).toBe(127);
  });

  test("uses last start sentinel (skips command echo)", () => {
    // The command echo contains the sentinel text, then the actual output
    // sentinel comes later. Parser must pick the last START, not the echo.
    const cleaned = [
      `root$ echo '${START}'; mycommand; echo '${END}'; echo '__VELLUM_EXIT_'$__ec`,
      START,
      "real output here",
      END,
      "__VELLUM_EXIT_0",
    ].join("\n");

    const result = parseSentinelOutput(cleaned, START, END);
    expect(result.output).toBe("real output here");
    expect(result.exitCode).toBe(0);
  });

  test("regression: end sentinel in echo before start sentinel in output", () => {
    // This was the original bug: backward search found END in the echo
    // (line 0) before START in the output (line 1), giving endIdx < startIdx.
    const cleaned = [
      `echo '${START}'; cmd; echo '${END}'; echo '__VELLUM_EXIT_'$__ec; exit $__ec`,
      START,
      "[INFO] Running clawhub command",
      '    args: ["search"]',
      '    cwd: "/workspace"',
    ].join("\n");

    // No end sentinel in actual output yet (stream was cut short in old code)
    const result = parseSentinelOutput(cleaned, START, END);
    // Should still return the partial output (no end sentinel → take everything)
    expect(result.output).toContain("[INFO] Running clawhub command");
    expect(result.output).toContain('cwd: "/workspace"');
  });

  test("handles multiline output with special characters", () => {
    const cleaned = [
      START,
      "📤 Resend Email Setup [installed]",
      "  ID: resend-setup",
      '  Set up and send emails via a user-provided Resend account (BYO email provider)',
      "",
      "Community registry (1):",
      "",
      "  resend-setup [installed]",
      END,
      "__VELLUM_EXIT_0",
    ].join("\n");

    const result = parseSentinelOutput(cleaned, START, END);
    expect(result.output).toContain("📤 Resend Email Setup");
    expect(result.output).toContain("Community registry (1):");
    expect(result.exitCode).toBe(0);
  });

  test("returns empty output and exit code 0 when no sentinels found", () => {
    const cleaned = "just some random output\nwith no sentinels\n";
    const result = parseSentinelOutput(cleaned, START, END);
    // Falls back to entire output (trimmed)
    expect(result.output).toBe(
      "just some random output\nwith no sentinels",
    );
    expect(result.exitCode).toBe(0);
  });

  test("handles output with only start sentinel (no end)", () => {
    const cleaned = [
      START,
      "partial output",
      "more output",
    ].join("\n");

    const result = parseSentinelOutput(cleaned, START, END);
    expect(result.output).toBe("partial output\nmore output");
    expect(result.exitCode).toBe(0);
  });

  test("handles real-world verbose trace structure", () => {
    // Simulates the full cleaned output from a real exec session
    const cleaned = [
      "root:/workspace$ root:/workspace$ " +
        `echo '${START}'; 'assistant' 'skills' 'search' 'resend-setup'; __ec=$?; echo ` +
        ` '${END}'; echo '__VELLUM_EXIT_'$__ec; exit $__ec`,
      START,
      "[13:06:38.851] INFO (761 on pod-0): [clawhub] Running clawhub command",
      '    args: [',
      '      "search",',
      '      "resend-setup",',
      '      "--limit",',
      '      "10"',
      "    ]",
      '    cwd: "/workspace"',
      "Bundled & installed skills (1):",
      "",
      "  📤 Resend Email Setup [installed]",
      "    ID: resend-setup",
      "",
      END,
      "__VELLUM_EXIT_0",
    ].join("\n");

    const result = parseSentinelOutput(cleaned, START, END);
    expect(result.output).toContain("Bundled & installed skills (1):");
    expect(result.output).toContain("📤 Resend Email Setup [installed]");
    expect(result.output).toContain("[clawhub] Running clawhub command");
    expect(result.exitCode).toBe(0);
  });
});
