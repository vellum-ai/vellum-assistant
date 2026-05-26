import { describe, expect, test } from "bun:test";

import {
  CLIENT_COMMANDS,
  allCommandNames,
  filterCommandSuggestions,
  groupCommandsForHelp,
  parseClientCommand,
} from "../lib/client-command-catalog.js";

describe("client command catalog", () => {
  test("contains the full M2 command set with descriptions", () => {
    expect(allCommandNames().sort()).toEqual(
      [
        "?",
        "/archive",
        "/btw",
        "/clear",
        "/copy",
        "/exit",
        "/export",
        "/help",
        "/new",
        "/q",
        "/quit",
        "/rename",
        "/resume",
      ].sort(),
    );

    for (const command of CLIENT_COMMANDS) {
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.usage.length).toBeGreaterThan(0);
    }
  });

  test("parses command aliases and trims arguments", () => {
    expect(parseClientCommand("  /rename   Project Alpha  ")).toMatchObject({
      command: "/rename",
      args: "Project Alpha",
    });

    const quit = parseClientCommand("/q");
    expect(quit?.entry.name).toBe("/exit");
    expect(quit?.command).toBe("/q");

    const help = parseClientCommand("?");
    expect(help?.entry.name).toBe("/help");
  });

  test("returns null for non-command input and unknown commands", () => {
    expect(parseClientCommand("hello")).toBeNull();
    expect(parseClientCommand("/missing")).toBeNull();
  });

  test("filters slash command suggestions by prefix", () => {
    expect(
      filterCommandSuggestions("/re").map((command) => command.name),
    ).toEqual(["/resume", "/rename"]);
    expect(
      filterCommandSuggestions("/q").map((command) => command.name),
    ).toEqual(["/exit"]);
    expect(filterCommandSuggestions("hello")).toEqual([]);
  });

  test("groups commands for compact help output", () => {
    const grouped = groupCommandsForHelp();

    expect(grouped.conversation.map((command) => command.name)).toEqual([
      "/new",
      "/resume",
      "/rename",
      "/archive",
    ]);
    expect(grouped.message.map((command) => command.name)).toEqual([
      "/btw",
      "/copy",
      "/export",
    ]);
    expect(grouped.utility.map((command) => command.name)).toEqual([
      "/clear",
      "/help",
      "/exit",
    ]);
  });
});
