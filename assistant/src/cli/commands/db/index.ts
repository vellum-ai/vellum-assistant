/**
 * `assistant db` — inspect and repair the assistant SQLite database directly
 * from disk.
 *
 * Subcommands declare `transport: "local"` so they work when the daemon is
 * down — which is precisely the failure mode this surface is most useful in.
 * Each subcommand opens its own bun:sqlite connection (read-only for
 * inspection, read-write for repair steps that mutate) and never goes
 * through IPC.
 */

import type { Command } from "commander";

import { applyCommandHelp } from "../../lib/cli-command-help.js";
import { registerCommand } from "../../lib/register-command.js";
import { dbHelp } from "./index.help.js";
import { registerDbRepair } from "./repair.js";
import { registerDbStatus } from "./status.js";

export function registerDbCommand(program: Command): void {
  registerCommand(program, {
    name: dbHelp.name,
    transport: "local",
    description: dbHelp.description,
    build: (db) => {
      applyCommandHelp(db, dbHelp);
      registerDbStatus(db);
      registerDbRepair(db);
    },
  });
}
