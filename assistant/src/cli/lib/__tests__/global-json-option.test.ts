import { describe, expect, it } from "bun:test";

import { Command } from "commander";

import { registerGlobalJsonOption } from "../global-json-option.js";

function hasJsonOption(cmd: Command): boolean {
  return cmd.options.some((opt) => opt.long === "--json");
}

describe("registerGlobalJsonOption", () => {
  it("adds --json to leaf commands (including nested leaves)", () => {
    const program = new Command();
    program.name("assistant");
    const memory = program.command("memory");
    const items = memory.command("items");
    const list = items.command("list");
    const status = program.command("status");

    registerGlobalJsonOption(program);

    expect(hasJsonOption(list)).toBe(true);
    expect(hasJsonOption(status)).toBe(true);
  });

  it("does NOT add --json to group commands (would steal the flag from subcommands)", () => {
    const program = new Command();
    program.name("assistant");
    const clients = program.command("clients");
    const list = clients.command("list");

    registerGlobalJsonOption(program);

    // Commander consumes a recognized option at the outermost declaring
    // command, so a group-level --json would swallow `clients list --json`
    // before the leaf action reads it.
    expect(hasJsonOption(clients)).toBe(false);
    expect(hasJsonOption(list)).toBe(true);
  });

  it("keeps `<group> <leaf> --json` bound to the leaf's own opts", () => {
    const program = new Command();
    program.name("assistant").exitOverride();
    const clients = program.command("clients");
    let leafJson: unknown;
    clients.command("list").action((opts: { json?: boolean }) => {
      leafJson = opts.json;
    });

    registerGlobalJsonOption(program);

    program.parse(["node", "assistant", "clients", "list", "--json"]);
    expect(leafJson).toBe(true);
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
