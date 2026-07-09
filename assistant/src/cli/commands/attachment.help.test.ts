/**
 * Guards the `attachment` command's static-help split:
 *
 *  - Fidelity: the help built from `attachment.help.ts` alone (no action
 *    handlers) is byte-identical to the fully-registered command's help, so the
 *    memory capability indexer reading the help module sees exactly what a user
 *    running `--help` sees, and the two cannot silently drift.
 *  - Import safety: `attachment.help.ts` imports only `commander` and the shared
 *    help contract — never the daemon/IPC action graph — so it can be imported
 *    from the memory subsystem without dragging the CLI into that import cycle.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { Command } from "commander";

import { subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { attachmentHelp } from "./attachment.help.js";
import { registerAttachmentCommand } from "./attachment.js";

function attachmentFrom(build: (program: Command) => void): Command {
  const program = new Command("assistant");
  build(program);
  return subcommand(program, "attachment");
}

describe("attachment static-help split", () => {
  test("help module reproduces the full command help (no drift)", () => {
    const registered = attachmentFrom(registerAttachmentCommand);
    const helpOnly = attachmentFrom((program) =>
      registerCommand(program, {
        name: attachmentHelp.name,
        transport: "ipc",
        description: attachmentHelp.description,
        build: attachmentHelp.configure,
      }),
    );

    expect(helpOnly.helpInformation()).toBe(registered.helpInformation());
    for (const name of ["register", "lookup"]) {
      expect(subcommand(helpOnly, name).helpInformation()).toBe(
        subcommand(registered, name).helpInformation(),
      );
    }
  });

  test("help module imports only commander and the help contract", () => {
    const source = readFileSync(
      join(import.meta.dir, "attachment.help.ts"),
      "utf8",
    );
    const importPaths = [
      ...source.matchAll(/^import[^"']*["']([^"']+)["']/gm),
    ].map((m) => m[1]);
    const allowed = new Set(["commander", "../lib/cli-command-help.js"]);
    for (const path of importPaths) {
      expect(allowed.has(path!)).toBe(true);
    }
  });
});
