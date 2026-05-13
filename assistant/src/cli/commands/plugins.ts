/**
 * `assistant plugins` — manage external plugins installed under
 * `<workspaceDir>/plugins/`.
 *
 * Gated by the `external-plugins` feature flag (see
 * {@link ../../plugins/feature-gate}). Today the only subcommand is
 * `install`, which delegates the heavy lifting to
 * {@link ../../plugins/install-from-github}.
 */

import type { Command } from "commander";

import {
  DEFAULT_PLUGIN_REF,
  installPlugin,
  PluginAlreadyInstalledError,
  PluginNotFoundError,
} from "../../plugins/install-from-github.js";
import { registerCommand } from "../lib/register-command.js";
import { getCliLogger } from "../logger.js";

const log = getCliLogger("plugins");

export function registerPluginsCommand(program: Command): void {
  registerCommand(program, {
    name: "plugins",
    transport: "local",
    description: "Manage external plugins",
    build: (plugins) => {
      plugins.addHelpText(
        "after",
        `
Examples:
  $ assistant plugins install simple-memory
  $ assistant plugins install simple-memory --force
  $ assistant plugins install simple-memory --ref my-feature-branch`,
      );

      plugins
        .command("install <name>")
        .description(
          "Install a plugin from vellum-ai/vellum-assistant/experimental/plugins/<name>",
        )
        .option("--force", "Overwrite an existing install")
        .option(
          "--ref <ref>",
          `Git ref to fetch from (default: ${DEFAULT_PLUGIN_REF})`,
        )
        .action(async (name: string, opts: { force?: boolean; ref?: string }) => {
          try {
            const result = await installPlugin(
              {
                name,
                force: opts.force ?? false,
                ref: opts.ref ?? DEFAULT_PLUGIN_REF,
              },
              { fetch: globalThis.fetch.bind(globalThis) },
            );
            log.info(
              {
                name: result.name,
                target: result.target,
                fileCount: result.fileCount,
                ref: result.ref,
              },
              "external plugin installed",
            );
            console.log(
              `Installed plugin "${result.name}" (${result.fileCount} file${result.fileCount === 1 ? "" : "s"}) → ${result.target}`,
            );
            console.log("Restart the assistant to pick up the new plugin.");
          } catch (err) {
            if (err instanceof PluginAlreadyInstalledError) {
              console.error(`${err.message}\nPass --force to overwrite.`);
              process.exitCode = 1;
              return;
            }
            if (err instanceof PluginNotFoundError) {
              console.error(err.message);
              process.exitCode = 1;
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Plugin install failed: ${message}`);
            process.exitCode = 1;
          }
        });
    },
  });
}
