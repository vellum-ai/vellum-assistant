import { describe, expect, test } from "bun:test";

import { buildCliProgram } from "../cli/program.js";
import { CLI_HELP_REFERENCE } from "../cli/reference.js";

/**
 * Guard test: CLI_HELP_REFERENCE must stay in sync with the actual CLI help
 * output produced by buildCliProgram().helpInformation().
 *
 * The snapshot in reference.ts is embedded in the system prompt (via
 * system-prompt.ts) so the assistant knows which CLI commands are available.
 * If the actual CLI program drifts from the snapshot, the system prompt will
 * contain stale information.
 *
 * When this test fails, update CLI_HELP_REFERENCE in
 * assistant/src/cli/reference.ts to match the current output of
 * buildCliProgram().helpInformation().
 */
describe("CLI_HELP_REFERENCE sync", () => {
  test("CLI_HELP_REFERENCE matches buildCliProgram().helpInformation()", () => {
    const program = buildCliProgram();
    const actual = program.helpInformation();

    expect(actual).toBe(CLI_HELP_REFERENCE);
  });
});
