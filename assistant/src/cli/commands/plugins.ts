/**
 * `assistant plugins` — manage external plugins installed under
 * `<workspaceDir>/plugins/`.
 *
 * Gated by the `external-plugins` feature flag (see
 * {@link ../../plugins/feature-gate}). Subcommands delegate the heavy
 * lifting to dedicated modules under {@link ../lib}.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
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
  PluginNotInstalledError,
  uninstallPlugin,
} from "../lib/uninstall-plugin.js";
import { getCliLogger } from "../logger.js";

const log = getCliLogger("plugins");

/**
 * Outcome of the post-install live-register IPC call. The CLI prints one of
 * three message families:
 *
 *   - "loaded" / "gated" — daemon accepted and integrated the plugin.
 *   - "feature-disabled" / "not-bootstrapped" / IPC connection failure —
 *     files are on disk but no live daemon to load them into.
 *   - "already-registered" / "build-failed" / "init-failed" — daemon is up
 *     but cannot load this plugin without a restart.
 *
 * Mirrors `PostBootInstallResult` in
 * `assistant/src/daemon/external-plugins-bootstrap.ts` — keep in sync.
 */
type RegisterInstalledPluginResult =
  | { status: "loaded"; name: string }
  | { status: "gated"; name: string; flag?: string }
  | { status: "already-registered"; name: string }
  | { status: "feature-disabled" }
  | { status: "not-bootstrapped" }
  | { status: "not-found"; pluginDir: string }
  | { status: "build-failed"; error: string }
  | { status: "init-failed"; name: string; error: string };

/**
 * Print the appropriate post-install message based on the daemon's response.
 * Pure I/O — does not touch `process.exitCode`. Install itself succeeded;
 * a live-register failure is a soft-fail (the files are still on disk and
 * will load on the next daemon start).
 */
function printPostInstallMessage(
  name: string,
  ipcResult:
    | { ok: true; result: RegisterInstalledPluginResult }
    | { ok: false; error?: string },
): void {
  if (!ipcResult.ok) {
    // Connection failure — daemon is offline. The CLI install action
    // already wrote files to disk, so they'll load on next start.
    console.log("Plugin installed. Start the assistant to load it.");
    return;
  }
  const r = ipcResult.result;
  switch (r.status) {
    case "loaded":
      console.log("Plugin loaded — tools available now.");
      return;
    case "gated": {
      const flag = r.flag ? ` (flag: ${r.flag})` : "";
      console.log(
        `Plugin installed but gated by a feature flag${flag}. Enable the flag and restart the assistant to load it.`,
      );
      return;
    }
    case "already-registered":
      console.log(
        `Plugin installed. "${name}" is already loaded — restart the assistant to pick up the updated version.`,
      );
      return;
    case "feature-disabled":
    case "not-bootstrapped":
      console.log("Plugin installed. Start the assistant to load it.");
      return;
    case "not-found":
      console.log(
        `Plugin installed but daemon could not locate the directory (${r.pluginDir}). Restart the assistant to retry.`,
      );
      return;
    case "build-failed":
      console.log(
        `Plugin installed (load failed: ${r.error}). Restart the assistant to retry.`,
      );
      return;
    case "init-failed":
      console.log(
        `Plugin installed (init failed: ${r.error}). Restart the assistant to retry.`,
      );
      return;
  }
}

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
            const ipcResult = await cliIpcCall<RegisterInstalledPluginResult>(
              "registerInstalledPlugin",
              { body: { name: result.name } },
            );
            printPostInstallMessage(
              result.name,
              ipcResult.ok && ipcResult.result !== undefined
                ? { ok: true, result: ipcResult.result }
                : { ok: false, error: ipcResult.error },
            );
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
