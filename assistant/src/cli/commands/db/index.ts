/**
 * `assistant db` — inspect and (in follow-up PRs) repair the assistant SQLite
 * database directly from disk.
 *
 * Subcommands declare `transport: "local"` so they work when the daemon is
 * down — which is precisely the failure mode this surface is most useful in.
 * Each subcommand opens its own bun:sqlite connection (read-only for `status`)
 * and never goes through IPC.
 */

import type { Command } from "commander";

import { registerCommand } from "../../lib/register-command.js";
import { registerDbStatus } from "./status.js";

export function registerDbCommand(program: Command): void {
  registerCommand(program, {
    name: "db",
    transport: "local",
    description:
      "Inspect and repair the assistant SQLite database (read-only by default)",
    build: (db) => {
      db.option("--json", "Machine-readable compact JSON output");
      registerDbStatus(db);
    },
  });
}
