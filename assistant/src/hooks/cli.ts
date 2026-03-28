import { chmodSync, cpSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { Command } from "commander";

import { pathExists } from "../util/fs.js";
import { getCliLogger } from "../util/logger.js";
import { getWorkspaceHooksDir } from "../util/platform.js";
import { ensureHookInConfig, removeHook, setHookEnabled } from "./config.js";
import { discoverHooks, isValidInstallManifest } from "./discovery.js";

const log = getCliLogger("hooks");

export function registerHooksCommand(program: Command): void {
  const hooks = program.command("hooks").description("Manage hooks");

  hooks.addHelpText(
    "after",
    `
Hooks are user-installed scripts that run in response to assistant lifecycle
events (e.g. tool invocations, message sends). Each hook is a directory
containing a hook.json manifest and a script file. Hooks are stored in
~/.vellum/hooks/ and must be explicitly enabled after installation.

Examples:
  $ assistant hooks list
  $ assistant hooks install ./my-hook
  $ assistant hooks enable my-hook
  $ assistant hooks disable my-hook`,
  );

  hooks
    .command("list")
    .description("List all installed hooks")
    .addHelpText(
      "after",
      `
Displays a table of all installed hooks with their name, subscribed events,
enabled status, and version.

Examples:
  $ assistant hooks list`,
    )
    .action(() => {
      const discovered = discoverHooks();
      if (discovered.length === 0) {
        log.info("No hooks installed");
        return;
      }

      const nameW = 24;
      const eventsW = 24;
      const enabledW = 10;
      log.info(
        "Name".padEnd(nameW) +
          "Events".padEnd(eventsW) +
          "Enabled".padEnd(enabledW) +
          "Version",
      );
      log.info("-".repeat(nameW + eventsW + enabledW + 10));

      for (const hook of discovered) {
        const events = hook.manifest.events.join(", ");
        const eventsTrunc =
          events.length > eventsW - 2
            ? events.slice(0, eventsW - 4) + ".."
            : events;
        log.info(
          hook.name.slice(0, nameW - 2).padEnd(nameW) +
            eventsTrunc.padEnd(eventsW) +
            (hook.enabled ? "yes" : "no").padEnd(enabledW) +
            (hook.manifest.version ?? "-"),
        );
      }
    });

  hooks
    .command("enable <name>")
    .description("Enable a hook")
    .addHelpText(
      "after",
      `
Arguments:
  name   Hook name as shown by 'assistant hooks list'

Enables a previously installed hook so it runs on matching events.

Examples:
  $ assistant hooks enable my-hook`,
    )
    .action((name: string) => {
      const discovered = discoverHooks();
      const hook = discovered.find((h) => h.name === name);
      if (!hook) {
        log.error(`Hook not found: ${name}`);
        process.exit(1);
      }
      setHookEnabled(name, true);
      log.info(`Enabled hook: ${name}`);
    });

  hooks
    .command("disable <name>")
    .description("Disable a hook")
    .addHelpText(
      "after",
      `
Arguments:
  name   Hook name as shown by 'assistant hooks list'

Disables a hook so it no longer runs on events. The hook remains installed
and can be re-enabled later.

Examples:
  $ assistant hooks disable my-hook`,
    )
    .action((name: string) => {
      const discovered = discoverHooks();
      const hook = discovered.find((h) => h.name === name);
      if (!hook) {
        log.error(`Hook not found: ${name}`);
        process.exit(1);
      }
      setHookEnabled(name, false);
      log.info(`Disabled hook: ${name}`);
    });

  hooks
    .command("install <path>")
    .description("Install a hook from a directory")
    .addHelpText(
      "after",
      `
Arguments:
  path   Path to a directory containing a hook.json manifest and a script file.
         The manifest must have name, script, description, version, and at
         least one valid event.

Copies the hook directory into ~/.vellum/hooks/<name>/ and registers it as
disabled by default. Run 'assistant hooks enable <name>' to activate.

Examples:
  $ assistant hooks install ./my-hook
  $ assistant hooks install /path/to/custom-hook`,
    )
    .action((hookPath: string) => {
      const srcDir = resolve(hookPath);
      if (!pathExists(srcDir)) {
        log.error(`Directory not found: ${srcDir}`);
        process.exit(1);
      }

      const manifestPath = join(srcDir, "hook.json");
      if (!pathExists(manifestPath)) {
        log.error(`No hook.json found in ${srcDir}`);
        process.exit(1);
      }

      let manifest: unknown;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      } catch {
        log.error(`Failed to parse hook.json in ${srcDir}`);
        process.exit(1);
      }

      if (!isValidInstallManifest(manifest)) {
        log.error(
          "Invalid hook.json: must have a non-empty name, script, description (string), version (string), and at least one valid event",
        );
        process.exit(1);
      }

      const hooksDir = getWorkspaceHooksDir();
      const resolvedHooksDir = resolve(hooksDir);
      const targetDir = resolve(join(hooksDir, manifest.name));
      if (!targetDir.startsWith(resolvedHooksDir + sep)) {
        log.error(
          `Invalid hook name: "${manifest.name}" would escape the hooks directory`,
        );
        process.exit(1);
      }

      const scriptPath = resolve(join(targetDir, manifest.script));
      if (!scriptPath.startsWith(targetDir + sep)) {
        log.error(
          `Invalid hook script: "${manifest.script}" would escape the hook directory`,
        );
        process.exit(1);
      }

      if (pathExists(targetDir)) {
        log.error(`Hook already installed: ${manifest.name}`);
        process.exit(1);
      }

      cpSync(srcDir, targetDir, { recursive: true });

      // Make script executable
      if (pathExists(scriptPath)) {
        chmodSync(scriptPath, 0o755);
      }

      ensureHookInConfig(manifest.name, { enabled: false });
      log.info(`Installed hook: ${manifest.name} (disabled by default)`);
    });

  hooks
    .command("remove <name>")
    .description("Remove an installed hook")
    .addHelpText(
      "after",
      `
Arguments:
  name   Hook name as shown by 'assistant hooks list'

Permanently deletes the hook directory and removes it from configuration.
Prompts for confirmation before proceeding.

Examples:
  $ assistant hooks remove my-hook`,
    )
    .action(async (name: string) => {
      const discovered = discoverHooks();
      const hook = discovered.find((h) => h.name === name);
      if (!hook) {
        log.error(`Hook not found: ${name}`);
        process.exit(1);
      }

      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await new Promise<string>((resolve) => {
        rl.question(
          `Remove hook "${name}" and delete its files? (y/N) `,
          resolve,
        );
      });
      rl.close();

      if (answer.toLowerCase() !== "y") {
        log.info("Cancelled");
        return;
      }

      rmSync(hook.dir, { recursive: true, force: true });
      removeHook(name);
      log.info(`Removed hook: ${name}`);
    });
}
