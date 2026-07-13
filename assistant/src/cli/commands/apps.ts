import type { Command } from "commander";

import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { appsHelp } from "./apps.help.js";

interface AppListEntry {
  name: string;
  source: string;
  id: string;
  formatVersion: number;
  updatedAt: number;
}

export function registerAppsCommand(program: Command): void {
  registerCommand(program, {
    name: appsHelp.name,
    transport: "local",
    description: appsHelp.description,
    build: (apps) => {
      applyCommandHelp(apps, appsHelp);

      subcommand(apps, "list").action(async (opts: { json?: boolean }) => {
        // Lazy-import the app store so the daemon module graph loads only when
        // this command runs (cli/no-daemon-internals).
        const { getAppsDir, listApps } =
          await import("../../apps/app-store.js");
        const { join } = await import("node:path");

        const appsDir = getAppsDir();
        const entries: AppListEntry[] = listApps()
          .map((app) => ({
            name: app.name,
            source: join(appsDir, app.dirName ?? app.id),
            id: app.id,
            formatVersion: app.formatVersion ?? 1,
            updatedAt: app.updatedAt,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        if (opts.json) {
          console.log(JSON.stringify({ ok: true, apps: entries }));
          return;
        }

        if (entries.length === 0) {
          log.info("No apps found.");
          return;
        }

        // Name and source lead; align both into columns so the source path is
        // scannable across rows.
        const nameWidth = Math.max(4, ...entries.map((e) => e.name.length));
        const srcWidth = Math.max(6, ...entries.map((e) => e.source.length));
        log.info(`Apps (${entries.length}):\n`);
        log.info(
          `  ${"NAME".padEnd(nameWidth)}  ${"SOURCE".padEnd(srcWidth)}  ID`,
        );
        for (const e of entries) {
          log.info(
            `  ${e.name.padEnd(nameWidth)}  ${e.source.padEnd(srcWidth)}  ${e.id}`,
          );
        }
      });
    },
  });
}
