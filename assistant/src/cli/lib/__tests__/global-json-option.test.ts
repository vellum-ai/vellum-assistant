import { describe, expect, it } from "bun:test";

import { Command } from "commander";

import { registerGlobalJsonOption } from "../global-json-option.js";

function hasJsonOption(cmd: Command): boolean {
  return cmd.options.some((opt) => opt.long === "--json");
}

describe("registerGlobalJsonOption", () => {
  it("adds --json to every subcommand, including nested ones", () => {
    const program = new Command();
    program.name("assistant");
    const memory = program.command("memory");
    const items = memory.command("items");
    items.command("list");
    const status = program.command("status");

    registerGlobalJsonOption(program);

    expect(hasJsonOption(memory)).toBe(true);
    expect(hasJsonOption(items)).toBe(true);
    expect(hasJsonOption(items.commands[0]!)).toBe(true);
    expect(hasJsonOption(status)).toBe(true);
  });

  it("does not duplicate --json on a command that already declares it", () => {
    const program = new Command();
    program.name("assistant");
    const sub = program.command("nodes");
    sub.option("--json", "Machine-readable compact JSON output");

    registerGlobalJsonOption(program);

    const jsonOptions = sub.options.filter((opt) => opt.long === "--json");
    expect(jsonOptions).toHaveLength(1);
    // The original description is preserved, not overwritten.
    expect(jsonOptions[0]!.description).toBe(
      "Machine-readable compact JSON output",
    );
  });

  it("leaves the root program without a --json option", () => {
    const program = new Command();
    program.name("assistant");
    program.command("status");

    registerGlobalJsonOption(program);

    expect(hasJsonOption(program)).toBe(false);
  });

  it("makes --json parse without error on a command that lacked it", () => {
    const program = new Command();
    program.name("assistant").exitOverride();
    let seenJson: unknown;
    program.command("status").action((opts: { json?: boolean }) => {
      seenJson = opts.json;
    });

    registerGlobalJsonOption(program);

    expect(() =>
      program.parse(["node", "assistant", "status", "--json"]),
    ).not.toThrow();
    expect(seenJson).toBe(true);
  });
});
