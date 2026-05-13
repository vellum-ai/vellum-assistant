import { describe, expect, it } from "bun:test";

import { detectUnknownCommand } from "../lib/unknown-command.js";
import { buildCliProgram } from "../program.js";
import { runAssistantCommandFull } from "./run-assistant-command.js";

describe("unknown command handling", () => {
  it("reports an error for an unknown subcommand", async () => {
    const { stderr } = await runAssistantCommandFull("invalid");

    expect(stderr).toContain("unknown command 'invalid'");
    expect(stderr).toContain("Run 'assistant --help'");
  });

  it("reports an error for an unknown subcommand with extra arguments", async () => {
    const { stderr } = await runAssistantCommandFull("invalid", "something");

    expect(stderr).toContain("unknown command 'invalid'");
    expect(stderr).toContain("Run 'assistant --help'");
  });

  it("suggests a similar command when the input is close", async () => {
    const { stderr } = await runAssistantCommandFull("confg");

    expect(stderr).toContain("unknown command 'confg'");
    expect(stderr).toContain("Did you mean 'config'");
  });

  it("does not suggest a command when the input is too far off", async () => {
    const { stderr } = await runAssistantCommandFull("xyzzy");

    expect(stderr).toContain("unknown command 'xyzzy'");
    expect(stderr).not.toContain("Did you mean");
  });

  // The `--help` flag triggers Commander's help short-circuit before any
  // action or hook runs, so the in-action detection in default-action.ts
  // can't catch it. The entrypoint pre-scans argv via detectUnknownCommand
  // to surface the error before Commander handles --help. This test guards
  // that path against regression.
  it("detects an unknown subcommand even when --help is passed", async () => {
    const program = await buildCliProgram();
    expect(detectUnknownCommand(program, ["invalid", "--help"])).toEqual({
      token: "invalid",
    });
    expect(detectUnknownCommand(program, ["confg", "--help"])).toEqual({
      token: "confg",
      suggestion: "config",
    });
  });

  it("does not flag known commands when --help is passed", async () => {
    const program = await buildCliProgram();
    expect(detectUnknownCommand(program, ["status", "--help"])).toBeNull();
    expect(detectUnknownCommand(program, ["config", "list", "--help"])).toBeNull();
  });
});
