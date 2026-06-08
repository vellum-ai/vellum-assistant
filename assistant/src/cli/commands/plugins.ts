/**
 * `assistant plugins` — manage external plugins installed under
 * `<workspaceDir>/plugins/`.
 *
 * Gated by the `external-plugins` feature flag (see
 * {@link ../../plugins/feature-gate}). Subcommands delegate the heavy
 * lifting to dedicated modules under {@link ../lib}.
 */

import type { Command } from "commander";

import { confirmPrompt } from "../lib/confirm-prompt.js";
import {
  DEFAULT_PLUGIN_REF,
  installPlugin,
  InvalidPluginNameError,
  PluginAlreadyInstalledError,
  PluginNotFoundError,
} from "../lib/install-from-github.js";
import { listInstalledPlugins } from "../lib/list-installed-plugins.js";
import { registerCommand } from "../lib/register-command.js";
import {
  InvalidSearchPatternError,
  searchPlugins,
} from "../lib/search-plugins.js";
import {
  PluginNotInstalledError,
  uninstallPlugin,
} from "../lib/uninstall-plugin.js";
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
  $ assistant plugins install simple-memory --ref my-feature-branch
  $ assistant plugins list
  $ assistant plugins list --json
  $ assistant plugins search memory
  $ assistant plugins search "^simple"
  $ assistant plugins search memory --json
  $ assistant plugins uninstall simple-memory`,
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
        .action(
          async (name: string, opts: { force?: boolean; ref?: string }) => {
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
                  commit: result.commit,
                },
                "external plugin installed",
              );
              const pinned = result.commit
                ? ` at ${result.commit.slice(0, 7)}`
                : "";
              console.log(
                `Installed plugin "${result.name}" (${result.fileCount} file${result.fileCount === 1 ? "" : "s"})${pinned} → ${result.target}`,
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
          },
        );

      plugins
        .command("list")
        .description("List plugins installed under <workspaceDir>/plugins/")
        .option("--json", "Emit machine-readable JSON instead of a table")
        .action((opts: { json?: boolean }) => {
          const installed = listInstalledPlugins();

          if (opts.json) {
            process.stdout.write(JSON.stringify(installed, null, 2) + "\n");
            return;
          }

          if (installed.length === 0) {
            console.log("No plugins installed.");
            return;
          }

          const rows = installed.map((p) => ({
            name: p.name,
            version: p.packageJson?.version ?? "—",
            status: p.issues.length === 0 ? "ok" : p.issues.join("; "),
          }));
          const nameW = Math.max(4, ...rows.map((r) => r.name.length));
          const versionW = Math.max(7, ...rows.map((r) => r.version.length));
          const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
          console.log(
            `${pad("NAME", nameW)}  ${pad("VERSION", versionW)}  STATUS`,
          );
          for (const r of rows) {
            console.log(
              `${pad(r.name, nameW)}  ${pad(r.version, versionW)}  ${r.status}`,
            );
          }
          console.log("");
          console.log(
            `${installed.length} plugin${installed.length === 1 ? "" : "s"} installed.`,
          );
        });

      plugins
        .command("search <query>")
        .description(
          "Search vellum-ai/vellum-assistant/experimental/plugins for plugin names matching <query> (case-insensitive regex)",
        )
        .option("--json", "Emit machine-readable JSON instead of a table")
        .action(async (query: string, opts: { json?: boolean }) => {
          try {
            const result = await searchPlugins(
              { query },
              { fetch: globalThis.fetch.bind(globalThis) },
            );

            // Log on every success path — JSON output, empty results, and
            // populated tables alike — so observability doesn't depend on
            // which formatting branch the caller landed in.
            log.info(
              {
                query: result.query,
                ref: result.ref,
                matchCount: result.matches.length,
              },
              "external plugin search",
            );

            if (opts.json) {
              process.stdout.write(JSON.stringify(result, null, 2) + "\n");
              return;
            }

            if (result.matches.length === 0) {
              console.log(`No plugins matched "${result.query}".`);
              return;
            }

            const nameW = Math.max(
              4,
              ...result.matches.map((m) => m.name.length),
            );
            const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
            console.log(`${pad("NAME", nameW)}  PATH`);
            for (const m of result.matches) {
              console.log(`${pad(m.name, nameW)}  ${m.path}`);
            }
            console.log("");
            console.log(
              `${result.matches.length} match${result.matches.length === 1 ? "" : "es"} for "${result.query}".`,
            );
          } catch (err) {
            if (err instanceof InvalidSearchPatternError) {
              console.error(err.message);
              process.exitCode = 1;
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Plugin search failed: ${message}`);
            process.exitCode = 1;
          }
        });

      plugins
        .command("uninstall <name>")
        .description("Remove a plugin from <workspaceDir>/plugins/<name>/")
        .option("--force", "Skip the confirmation prompt")
        .action(async (name: string, opts: { force?: boolean }) => {
          try {
            if (!opts.force) {
              const result = await confirmPrompt({
                question: `Uninstall plugin "${name}"? [y/N] `,
                isTTY: Boolean(process.stdin.isTTY),
                refuseNonInteractiveMessage: `Refusing to uninstall "${name}" non-interactively. Pass --force to confirm.`,
              });
              if (result === "non-interactive") {
                process.exitCode = 1;
                return;
              }
              if (result === "denied") {
                console.log("Uninstall cancelled.");
                return;
              }
            }
            const result = uninstallPlugin({ name });
            log.info(
              { name: result.name, target: result.target },
              "external plugin uninstalled",
            );
            console.log(
              `Uninstalled plugin "${result.name}" from ${result.target}`,
            );
            console.log("Restart the assistant to drop the plugin.");
          } catch (err) {
            if (err instanceof InvalidPluginNameError) {
              console.error(err.message);
              process.exitCode = 1;
              return;
            }
            if (err instanceof PluginNotInstalledError) {
              console.error(err.message);
              process.exitCode = 1;
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Plugin uninstall failed: ${message}`);
            process.exitCode = 1;
          }
        });
    },
  });
}
