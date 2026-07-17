/**
 * Coverage guard: every top-level `assistant` CLI command must declare its
 * help as pure data in `CLI_COMMAND_HELP` (via a `<command>.help.ts` module).
 *
 * The memory capability indexer seeds CLI commands purely from
 * `CLI_COMMAND_HELP` — it does NOT walk the Commander tree — so a command that
 * registers without a declarative help entry would be silently invisible to
 * semantic discovery. This test fails loudly in that case, standing in for the
 * old `buildCliProgramTree()` fallback that used to catch such gaps at runtime.
 */
import { describe, expect, test } from "bun:test";

import { CLI_COMMAND_HELP } from "../index.help.js";
import { buildCliProgramTree } from "../program.js";

describe("CLI declarative help coverage", () => {
  test("every registered command has a CLI_COMMAND_HELP entry", () => {
    const declared = new Set(CLI_COMMAND_HELP.map((h) => h.name));
    const program = buildCliProgramTree();

    // Commander auto-injects a `help` builtin that carries no capability of its
    // own; every other top-level command must be declared.
    const missing = program.commands
      .map((command) => command.name())
      .filter((name) => name !== "help" && !declared.has(name));

    expect(missing).toEqual([]);
  });
});
