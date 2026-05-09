import { describe, expect, test } from "bun:test";

import { Command } from "commander";

import { type CommandTransport, registerCommand } from "../register-command.js";

describe("registerCommand", () => {
  test("registers a command with the correct name and description", () => {
    const parent = new Command();
    const result = registerCommand(parent, {
      name: "test-cmd",
      transport: "ipc",
      description: "A test command",
      build: () => {},
    });

    expect(result.name()).toBe("test-cmd");
    expect(result.description()).toBe("A test command");
  });

  test("calls build with the command instance", () => {
    const parent = new Command();
    let receivedCmd: Command | undefined;

    registerCommand(parent, {
      name: "my-cmd",
      transport: "local",
      description: "My command",
      build: (cmd) => {
        receivedCmd = cmd;
      },
    });

    expect(receivedCmd).toBeDefined();
    expect(receivedCmd!.name()).toBe("my-cmd");
  });

  test("returns the registered command", () => {
    const parent = new Command();
    const result = registerCommand(parent, {
      name: "ret-cmd",
      transport: "bootstrap",
      description: "Return test",
      build: () => {},
    });

    expect(result).toBeInstanceOf(Command);
    expect(result.name()).toBe("ret-cmd");
  });

  test.each([
    ["ipc" as CommandTransport],
    ["local" as CommandTransport],
    ["bootstrap" as CommandTransport],
  ])("accepts transport value: %s", (transport) => {
    const parent = new Command();
    let buildCalled = false;

    const result = registerCommand(parent, {
      name: `cmd-${transport}`,
      transport,
      description: `Command with transport ${transport}`,
      build: () => {
        buildCalled = true;
      },
    });

    expect(buildCalled).toBe(true);
    expect(result.name()).toBe(`cmd-${transport}`);
    expect(result.description()).toBe(`Command with transport ${transport}`);
  });

  test("attaches the command as a subcommand of parent", () => {
    const parent = new Command("program");
    registerCommand(parent, {
      name: "sub",
      transport: "ipc",
      description: "Subcommand",
      build: () => {},
    });

    const names = parent.commands.map((c) => c.name());
    expect(names).toContain("sub");
  });
});
