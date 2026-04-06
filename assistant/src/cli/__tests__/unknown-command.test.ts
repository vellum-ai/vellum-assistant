import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

describe("unknown command handling", () => {
  const errorSpy = mock((..._args: unknown[]) => {});
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    process.exitCode = 0;
    errorSpy.mockClear();
    originalConsoleError = console.error;
    console.error = errorSpy as unknown as typeof console.error;
  });

  afterEach(() => {
    console.error = originalConsoleError;
    process.exitCode = 0;
  });

  async function runCommand(...args: string[]): Promise<void> {
    const { buildCliProgram } = await import("../program.js");
    const program = buildCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });

    try {
      await program.parseAsync(["node", "assistant", ...args]);
    } catch {
      /* commander exit override throws */
    }
  }

  it("reports an error for an unknown subcommand", async () => {
    await runCommand("invalid");
    const output = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");

    expect(output).toContain("error: unknown command 'invalid'");
    expect(output).toContain("Run 'assistant --help'");
    expect(process.exitCode).toBe(1);
  });

  it("reports an error for an unknown subcommand with extra arguments", async () => {
    await runCommand("invalid", "something");
    const output = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");

    expect(output).toContain("error: unknown command 'invalid'");
    expect(output).toContain("Run 'assistant --help'");
    expect(process.exitCode).toBe(1);
  });

  it("suggests a similar command when the input is close", async () => {
    await runCommand("confg");
    const output = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");

    expect(output).toContain("error: unknown command 'confg'");
    expect(output).toContain("Did you mean 'config'");
    expect(process.exitCode).toBe(1);
  });

  it("does not suggest a command when the input is too far off", async () => {
    await runCommand("xyzzy");
    const output = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");

    expect(output).toContain("error: unknown command 'xyzzy'");
    expect(output).not.toContain("Did you mean");
    expect(process.exitCode).toBe(1);
  });
});
