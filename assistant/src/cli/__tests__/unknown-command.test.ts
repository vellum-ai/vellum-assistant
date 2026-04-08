import { describe, expect, it } from "bun:test";

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
});
