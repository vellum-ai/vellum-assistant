import { describe, expect, it } from "bun:test";

import { Command } from "commander";

import {
  detectUnknownCommand,
  findClosestCommand,
  formatUnknownCommandMessage,
  knownCommandNames,
} from "../unknown-command.js";

function buildToyProgram(): Command {
  const program = new Command();
  program.name("assistant").description("toy");
  program.command("status").description("show status");
  program.command("config").description("manage config");
  program.command("pending").alias("ls").description("inspect pending");
  return program;
}

describe("knownCommandNames", () => {
  it("collects command names and aliases", () => {
    const names = knownCommandNames(buildToyProgram());
    expect([...names].sort()).toEqual(["config", "ls", "pending", "status"]);
  });
});

describe("findClosestCommand", () => {
  it("returns the closest match within 40% distance", () => {
    expect(findClosestCommand("confg", ["config", "status"])).toBe("config");
  });

  it("returns undefined when nothing is close enough", () => {
    expect(findClosestCommand("xyzzy", ["config", "status"])).toBeUndefined();
  });

  it("is case-insensitive for comparison", () => {
    expect(findClosestCommand("STATUS", ["status"])).toBe("status");
  });
});

describe("detectUnknownCommand", () => {
  const program = buildToyProgram();

  it("returns null when no positional is present (root --help / --version)", () => {
    expect(detectUnknownCommand(program, ["--help"])).toBeNull();
    expect(detectUnknownCommand(program, ["-V"])).toBeNull();
    expect(detectUnknownCommand(program, [])).toBeNull();
  });

  it("returns null when the first positional is a known command", () => {
    expect(detectUnknownCommand(program, ["status"])).toBeNull();
    expect(detectUnknownCommand(program, ["status", "--json"])).toBeNull();
  });

  it("returns null when the first positional is a registered alias", () => {
    expect(detectUnknownCommand(program, ["ls"])).toBeNull();
  });

  it("flags an unknown first positional even when --help follows", () => {
    expect(detectUnknownCommand(program, ["invalid", "--help"])).toEqual({
      token: "invalid",
    });
  });

  it("flags an unknown first positional even when --help precedes it", () => {
    expect(detectUnknownCommand(program, ["--help", "invalid"])).toEqual({
      token: "invalid",
    });
  });

  it("includes a suggestion when the unknown token is close to a known one", () => {
    expect(detectUnknownCommand(program, ["confg", "--help"])).toEqual({
      token: "confg",
      suggestion: "config",
    });
  });

  it("omits suggestion when nothing is close enough", () => {
    expect(detectUnknownCommand(program, ["xyzzy"])).toEqual({
      token: "xyzzy",
    });
  });
});

describe("formatUnknownCommandMessage", () => {
  it("emits two lines when there is no suggestion", () => {
    const msg = formatUnknownCommandMessage({ token: "invalid" });
    expect(msg.split("\n")).toEqual([
      "unknown command 'invalid'",
      "Run 'assistant --help' to see a list of available commands.",
    ]);
  });

  it("inserts the suggestion line between the header and footer", () => {
    const msg = formatUnknownCommandMessage({
      token: "confg",
      suggestion: "config",
    });
    expect(msg.split("\n")).toEqual([
      "unknown command 'confg'",
      "(Did you mean 'config'?)",
      "Run 'assistant --help' to see a list of available commands.",
    ]);
  });
});
