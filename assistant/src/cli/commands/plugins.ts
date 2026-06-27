/**
 * `assistant plugins` — manage external plugins installed under
 * `<workspaceDir>/plugins/`.
 *
 * Subcommands delegate the heavy lifting to dedicated modules under
 * {@link ../lib}.
 */

import type { Command } from "commander";

import { yellow } from "../lib/cli-colors.js";
import { confirmPrompt } from "../lib/confirm-prompt.js";
import {
  diffPlugin,
  type PluginDiffResult,
  PluginDiffUnavailableError,
} from "../lib/diff-plugin.js";
import {
  inspectPlugin,
  type PluginInspection,
  PluginInspectNotFoundError,
  type PluginRemoteInfo,
} from "../lib/inspect-plugin.js";
import {
  DEFAULT_PLUGIN_REF,
  installPlugin,
  type InstallPluginOptions,
  InvalidPluginNameError,
  PluginAlreadyInstalledError,
  type PluginFetchSource,
  PluginNotFoundError,
  sanitizePluginName,
} from "../lib/install-from-github.js";
import {
  type AllPluginInfo,
  listAllPlugins,
  listInstalledPlugins,
} from "../lib/list-installed-plugins.js";
import {
  DEFAULT_DIRECT_REF,
  InvalidGitHubPluginSpecError,
  looksLikeGitHubSpec,
  parseGitHubPluginSpec,
} from "../lib/parse-github-plugin-spec.js";
import type { FingerprintComparison } from "../lib/plugin-fingerprint.js";
import {
  DEFAULT_PIN_HISTORY_LIMIT,
  listPinHistory,
  type PluginPinHistoryEntry,
  PluginPinHistoryError,
  resolvePinToMarketplaceCommit,
} from "../lib/plugin-pin-history.js";
import { runPublish } from "../lib/publish-plugin.js";
import { registerCommand } from "../lib/register-command.js";
import {
  InvalidSearchPatternError,
  searchPlugins,
} from "../lib/search-plugins.js";
import {
  disablePlugin,
  enablePlugin,
  InvalidPluginNameError as ToggleInvalidPluginNameError,
  PluginAlreadyInStateException,
  PluginDirectoryNotFoundError,
} from "../lib/toggle-plugin.js";
import {
  PluginNotInstalledError,
  uninstallPlugin,
} from "../lib/uninstall-plugin.js";
import {
  DEFAULT_PLUGIN_UPGRADE_STRATEGY,
  PLUGIN_UPGRADE_STRATEGIES,
  PluginMergeBaselineError,
  PluginNotUpgradableError,
  type PluginUpgradeResult,
  type PluginUpgradeStrategy,
  upgradePlugin,
} from "../lib/upgrade-plugin.js";
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
  $ assistant plugins install example
  $ assistant plugins install example --force
  $ assistant plugins install https://github.com/owner/repo
  $ assistant plugins install https://github.com/owner/repo/tree/main/sub/path --name my-plugin
  $ assistant plugins install example --ref my-feature-branch
  $ assistant plugins versions example
  $ assistant plugins versions example --json
  $ assistant plugins install example --pin <sha> --force
  $ assistant plugins list
  $ assistant plugins list --json
  $ assistant plugins list --all
  $ assistant plugins list --all --json
  $ assistant plugins inspect example
  $ assistant plugins inspect example --json
  $ assistant plugins diff example
  $ assistant plugins diff example --json
  $ assistant plugins upgrade example
  $ assistant plugins upgrade example --dry-run
  $ assistant plugins upgrade example --strategy ours
  $ assistant plugins upgrade example --strategy theirs
  $ assistant plugins upgrade example --strategy assistant
  $ assistant plugins search example
  $ assistant plugins search "^example"
  $ assistant plugins search example --json
  $ assistant plugins uninstall example
  $ assistant plugins enable example
  $ assistant plugins disable example`,
      );

      plugins
        .command("install <name-or-url>")
        .description(
          "Install a plugin by name from the curated plugins/marketplace.json catalog, or directly from a GitHub URL (untrusted)",
        )
        .option("--force", "Overwrite an existing install")
        .option(
          "--ref <ref>",
          `Marketplace manifest revision to read the pin from (default: ${DEFAULT_PLUGIN_REF}). Marketplace installs only — for a GitHub URL, put the ref in the URL (.../tree/<ref>/...)`,
        )
        .option(
          "--pin <sha>",
          "Install a specific reviewed marketplace pin (full commit SHA); run `plugins versions <name>` to list them. Marketplace installs only",
        )
        .option(
          "--allow-unreviewed",
          "With --pin, install a SHA that is not in the reviewed marketplace history (advanced; the curated adapter may not match). Marketplace installs only",
        )
        .option(
          "--name <name>",
          "Install directory name for a GitHub-URL install (default: derived from the repo or sub-path leaf). Ignored for marketplace installs",
        )
        .addHelpText(
          "after",
          `
A GitHub URL (anything containing a slash) installs directly from that repo,
bypassing the marketplace whitelist. Such a plugin is UNTRUSTED — it has not
been reviewed and its hooks/tools run with full assistant access — so the
install prints a warning. Use it for a plugin still under development that is
not in the catalog yet. The ref comes from the URL's /tree/<ref>/ segment, or
defaults to the repository's default branch.

Examples:
  $ assistant plugins install https://github.com/owner/repo
  $ assistant plugins install https://github.com/owner/repo/tree/my-branch/path/to/plugin
  $ assistant plugins install owner/repo --name my-plugin --force`,
        )
        .action(
          async (
            nameOrUrl: string,
            opts: {
              force?: boolean;
              ref?: string;
              pin?: string;
              allowUnreviewed?: boolean;
              name?: string;
            },
          ) => {
            try {
              const direct = looksLikeGitHubSpec(nameOrUrl);
              const installOpts = direct
                ? resolveDirectInstallOptions(nameOrUrl, opts)
                : await resolveInstallOptions(nameOrUrl, opts);
              if (installOpts === null) {
                process.exitCode = 1;
                return;
              }
              if (installOpts.directSource) {
                printUntrustedPluginWarning(
                  installOpts.name,
                  installOpts.directSource,
                );
              }
              const result = await installPlugin(installOpts, {
                fetch: globalThis.fetch.bind(globalThis),
              });
              log.info(
                {
                  name: result.name,
                  target: result.target,
                  fileCount: result.fileCount,
                  ref: result.ref,
                  commit: result.commit,
                  untrusted: Boolean(installOpts.directSource),
                },
                "external plugin installed",
              );
              const pinned = result.commit
                ? ` at ${result.commit.slice(0, 7)}`
                : "";
              const label = installOpts.directSource
                ? "untrusted plugin"
                : "plugin";
              console.log(
                `Installed ${label} "${result.name}" (${result.fileCount} file${result.fileCount === 1 ? "" : "s"})${pinned} → ${result.target}`,
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
              if (
                err instanceof InvalidPluginNameError ||
                err instanceof PluginPinHistoryError
              ) {
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
        .command("versions <name>")
        .description(
          "List the recent reviewed marketplace pins for a plugin, newest first. Install an older one with `plugins install <name> --pin <sha>`",
        )
        .option("--json", "Emit machine-readable JSON instead of a table")
        .option(
          "--limit <n>",
          `Maximum number of pins to show (default: ${DEFAULT_PIN_HISTORY_LIMIT})`,
        )
        .action(
          async (name: string, opts: { json?: boolean; limit?: string }) => {
            let limit: number | undefined;
            if (opts.limit !== undefined) {
              limit = Number.parseInt(opts.limit, 10);
              if (!Number.isInteger(limit) || limit < 1) {
                console.error("--limit must be a positive integer.");
                process.exitCode = 1;
                return;
              }
            }
            try {
              const history = await listPinHistory(
                name,
                { fetch: globalThis.fetch.bind(globalThis) },
                limit !== undefined ? { limit } : {},
              );

              if (opts.json) {
                process.stdout.write(JSON.stringify(history, null, 2) + "\n");
                return;
              }

              // Logged after the JSON early-return so the logger's stdout
              // writes never corrupt --json output.
              log.info({ name, count: history.length }, "plugin versions");
              for (const line of formatVersions(name, history)) {
                console.log(line);
              }
            } catch (err) {
              if (
                err instanceof InvalidPluginNameError ||
                err instanceof PluginPinHistoryError
              ) {
                console.error(err.message);
                process.exitCode = 1;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              console.error(`Plugin versions failed: ${message}`);
              process.exitCode = 1;
            }
          },
        );

      plugins
        .command("list")
        .description("List plugins installed in your workspace.")
        .option("--json", "Emit machine-readable JSON instead of a table")
        .option(
          "--all",
          "Include first-party default plugins and disabled plugins in the listing",
        )
        .action((opts: { json?: boolean; all?: boolean }) => {
          if (opts.all) {
            const all = listAllPlugins();

            if (opts.json) {
              process.stdout.write(JSON.stringify(all, null, 2) + "\n");
              return;
            }

            if (all.length === 0) {
              console.log("No plugins found.");
              return;
            }

            const rows = all.map((p) => ({
              name: p.name,
              version: p.packageJson?.version ?? "—",
              source: p.source,
              status: formatAllPluginStatus(p),
            }));
            const nameW = Math.max(4, ...rows.map((r) => r.name.length));
            const versionW = Math.max(7, ...rows.map((r) => r.version.length));
            const sourceW = Math.max(6, ...rows.map((r) => r.source.length));
            const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
            console.log(
              `${pad("NAME", nameW)}  ${pad("VERSION", versionW)}  ${pad("SOURCE", sourceW)}  STATUS`,
            );
            for (const r of rows) {
              console.log(
                `${pad(r.name, nameW)}  ${pad(r.version, versionW)}  ${pad(r.source, sourceW)}  ${r.status}`,
              );
            }

            const userCount = all.filter((p) => p.source === "user").length;
            const defaultCount = all.length - userCount;
            const disabledCount = all.filter((p) => p.disabled).length;
            console.log("");
            console.log(
              `${all.length} plugin${all.length === 1 ? "" : "s"} ` +
                `(${userCount} user, ${defaultCount} default` +
                (disabledCount > 0 ? `, ${disabledCount} disabled` : "") +
                `).`,
            );
            return;
          }

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
        .command("inspect <name>")
        .description(
          "Show a plugin's local install metadata, the marketplace pin, whether an update is available, and the surfaces (skills, hooks, tools) it contributes",
        )
        .option("--json", "Emit machine-readable JSON instead of a summary")
        .action(async (name: string, opts: { json?: boolean }) => {
          try {
            const inspection = await inspectPlugin(
              { name },
              { fetch: globalThis.fetch.bind(globalThis) },
            );

            if (opts.json) {
              process.stdout.write(JSON.stringify(inspection, null, 2) + "\n");
              return;
            }

            // Logged after the JSON early-return: the CLI logger writes
            // info to stdout, which would otherwise corrupt --json output.
            log.info(
              {
                name: inspection.name,
                installed: inspection.installed,
                status: inspection.status,
              },
              "plugin inspect",
            );

            for (const line of formatInspection(inspection)) {
              console.log(line);
            }
          } catch (err) {
            if (err instanceof PluginInspectNotFoundError) {
              console.error(err.message);
              process.exitCode = 1;
              return;
            }
            if (err instanceof InvalidPluginNameError) {
              console.error(err.message);
              process.exitCode = 1;
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Plugin inspect failed: ${message}`);
            process.exitCode = 1;
          }
        });

      plugins
        .command("diff <name>")
        .description(
          "Show a unified diff of local edits to an installed plugin against the commit it was installed at",
        )
        .option(
          "--json",
          "Emit the machine-readable diff result as JSON (files: { path, status, diff, binary, reconstructed }[]) instead of a unified diff",
        )
        .addHelpText(
          "after",
          `
Arguments:
  name   Install name (kebab-case directory under the workspace plugins dir);
         run 'assistant plugins list' to see installed names.

The baseline is the exact commit the plugin was installed at (recorded in its
install-meta.json), re-materialized through the install pipeline — so an
install-time adapter transform never reads as a local change. To compare
against the marketplace's current pin instead, use 'plugins upgrade --dry-run'.

Examples:
  $ assistant plugins diff example
  $ assistant plugins diff example --json`,
        )
        .action(async (name: string, opts: { json?: boolean }) => {
          try {
            const result = await diffPlugin(
              { name },
              { fetch: globalThis.fetch.bind(globalThis) },
            );

            if (opts.json) {
              process.stdout.write(JSON.stringify(result, null, 2) + "\n");
              return;
            }

            // Logged after the JSON early-return: the CLI logger writes
            // info to stdout, which would otherwise corrupt --json output.
            log.info(
              {
                name: result.name,
                clean: result.clean,
                files: result.files.length,
              },
              "plugin diff",
            );

            for (const line of formatDiff(result)) {
              console.log(line);
            }
          } catch (err) {
            if (
              err instanceof PluginNotInstalledError ||
              err instanceof PluginDiffUnavailableError ||
              err instanceof InvalidPluginNameError
            ) {
              console.error(err.message);
              process.exitCode = 1;
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Plugin diff failed: ${message}`);
            process.exitCode = 1;
          }
        });

      plugins
        .command("search <query>")
        .description(
          "Search the plugins/marketplace.json catalog for plugin names matching <query> (case-insensitive regex)",
        )
        .option("--json", "Emit machine-readable JSON instead of a table")
        .action(async (query: string, opts: { json?: boolean }) => {
          try {
            const result = await searchPlugins(
              { query },
              { fetch: globalThis.fetch.bind(globalThis) },
            );

            if (opts.json) {
              process.stdout.write(JSON.stringify(result, null, 2) + "\n");
              return;
            }

            // Logged after the JSON early-return: the CLI logger writes info
            // to stdout, which would otherwise corrupt --json output.
            log.info(
              {
                query: result.query,
                ref: result.ref,
                matchCount: result.matches.length,
              },
              "external plugin search",
            );

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
        .command("publish")
        .description(
          "Validate and submit the plugin in the current directory to the Vellum marketplace catalog",
        )
        .option(
          "--print",
          "Print the entry JSON without submitting to the platform",
        )
        .option(
          "--path <dir>",
          "Validate a plugin at the given path instead of CWD",
        )
        .option("--force", "Skip the confirmation prompt")
        .option("--json", "Emit machine-readable JSON instead of human output")
        .option(
          "--category <cat>",
          "Set the category, skipping the interactive prompt",
        )
        .addHelpText(
          "after",
          `

Validates the plugin in the current directory (or --path), resolves the
git commit SHA and GitHub remote, and submits the entry to the Vellum
platform API. The platform creates a pull request against
vellum-ai/vellum-assistant adding the plugin to the marketplace catalog.

Requires a connected Vellum platform account (run \`assistant platform connect\`).
Use --print to validate and print the entry without submitting.

Examples:
$ assistant plugins publish
$ assistant plugins publish --print
$ assistant plugins publish --path ./my-plugin --category productivity
$ assistant plugins publish --json`,
        )
        .action(
          async (opts: {
            print?: boolean;
            path?: string;
            force?: boolean;
            json?: boolean;
            category?: string;
          }) => {
            const ok = await runPublish(opts, { confirmPrompt });
            if (!ok) process.exitCode = 1;
          },
        );

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

      plugins
        .command("disable <name>")
        .description(
          "Disable a plugin by creating a .disabled sentinel file. Works for both user-installed and default plugins. Takes effect immediately in a running assistant.",
        )
        .action((name: string) => {
          try {
            const result = disablePlugin(name);
            log.info({ name: result.name }, "plugin disabled");
            console.log(`Disabled plugin "${result.name}".`);
          } catch (err) {
            if (
              err instanceof PluginAlreadyInStateException ||
              err instanceof ToggleInvalidPluginNameError ||
              err instanceof PluginDirectoryNotFoundError
            ) {
              console.error(err.message);
              process.exitCode = 1;
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Plugin disable failed: ${message}`);
            process.exitCode = 1;
          }
        });

      plugins
        .command("enable <name>")
        .description(
          "Re-enable a disabled plugin by removing the .disabled sentinel file. Takes effect immediately.",
        )
        .action((name: string) => {
          try {
            const result = enablePlugin(name);
            log.info({ name: result.name }, "plugin enabled");
            console.log(`Enabled plugin "${result.name}".`);
          } catch (err) {
            if (
              err instanceof PluginAlreadyInStateException ||
              err instanceof ToggleInvalidPluginNameError
            ) {
              console.error(err.message);
              process.exitCode = 1;
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Plugin enable failed: ${message}`);
            process.exitCode = 1;
          }
        });

      plugins
        .command("upgrade <name>")
        .description(
          "Upgrade an installed plugin to the marketplace's current pin",
        )
        .option(
          "--dry-run",
          "Show what would change without modifying the install",
        )
        .option(
          "--strategy <strategy>",
          `How to reconcile local edits with the pin: ${PLUGIN_UPGRADE_STRATEGIES.join(", ")} (default: ${DEFAULT_PLUGIN_UPGRADE_STRATEGY})`,
        )
        .option("--json", "Emit machine-readable JSON instead of a summary")
        .action(
          async (
            name: string,
            opts: { dryRun?: boolean; strategy?: string; json?: boolean },
          ) => {
            const strategy = opts.strategy;
            if (
              strategy !== undefined &&
              !(PLUGIN_UPGRADE_STRATEGIES as readonly string[]).includes(
                strategy,
              )
            ) {
              console.error(
                `Invalid --strategy "${strategy}". Expected one of: ${PLUGIN_UPGRADE_STRATEGIES.join(", ")}.`,
              );
              process.exitCode = 1;
              return;
            }
            try {
              const result = await upgradePlugin(
                {
                  name,
                  dryRun: opts.dryRun,
                  strategy: strategy as PluginUpgradeStrategy | undefined,
                },
                { fetch: globalThis.fetch.bind(globalThis) },
              );

              if (opts.json) {
                process.stdout.write(JSON.stringify(result, null, 2) + "\n");
                return;
              }

              // Logged after the JSON early-return: the CLI logger writes
              // info to stdout, which would otherwise corrupt --json output.
              log.info(
                {
                  name: result.name,
                  outcome: result.outcome,
                  from: result.fromCommit,
                  to: result.toCommit,
                },
                "plugin upgrade",
              );

              for (const line of formatUpgrade(result)) {
                console.log(line);
              }
            } catch (err) {
              if (
                err instanceof PluginNotInstalledError ||
                err instanceof PluginNotUpgradableError ||
                err instanceof PluginMergeBaselineError ||
                err instanceof InvalidPluginNameError
              ) {
                console.error(err.message);
                process.exitCode = 1;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              console.error(`Plugin upgrade failed: ${message}`);
              process.exitCode = 1;
            }
          },
        );
    },
  });
}

/** Abbreviate a commit SHA for display; passes through non-SHA / null values. */
/** Full Git commit SHA — 40 hex (SHA-1) or 64 (SHA-256). */
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Resolve `plugins install` flags into {@link InstallPluginOptions}, or `null`
 * when the flag combination is invalid (a message is printed in that case, and
 * the caller exits non-zero). Network / marketplace failures raised while
 * resolving a `--pin` propagate to the caller's catch.
 *
 * `--pin <sha>` installs a specific reviewed marketplace pin: the SHA is looked
 * up in the plugin's pin history and installed from the marketplace commit that
 * introduced it, so the curated adapter stub of that era comes along. With
 * `--allow-unreviewed` the SHA is materialized directly (adapter from `main`),
 * bypassing the history check — the advanced escape hatch.
 */
async function resolveInstallOptions(
  name: string,
  opts: {
    force?: boolean;
    ref?: string;
    pin?: string;
    allowUnreviewed?: boolean;
  },
): Promise<InstallPluginOptions | null> {
  const force = opts.force ?? false;

  if (!opts.pin) {
    if (opts.allowUnreviewed) {
      console.error("--allow-unreviewed only applies together with --pin.");
      return null;
    }
    return { name, force, ref: opts.ref ?? DEFAULT_PLUGIN_REF };
  }

  const pin = opts.pin.trim();
  if (!FULL_SHA_RE.test(pin)) {
    console.error(
      `--pin must be a full commit SHA (40 or 64 hex chars); got ${JSON.stringify(opts.pin)}.`,
    );
    return null;
  }
  if (opts.ref) {
    console.error(
      "--ref and --pin cannot be combined; --pin already selects the revision.",
    );
    return null;
  }

  if (opts.allowUnreviewed) {
    // Materialize the exact SHA from the plugin's current-manifest repo,
    // bypassing the reviewed-history check. The adapter stub still comes from
    // the default ref, so an adapted plugin may not reproduce faithfully.
    return { name, force, ref: DEFAULT_PLUGIN_REF, commitOverride: pin };
  }

  const entry = await resolvePinToMarketplaceCommit(name, pin, {
    fetch: globalThis.fetch.bind(globalThis),
  });
  if (!entry) {
    console.error(
      `"${pin}" is not a reviewed marketplace pin for "${name}".\n` +
        `Run \`assistant plugins versions ${name}\` to see available pins, ` +
        "or pass --allow-unreviewed to install it anyway.",
    );
    return null;
  }
  return { name, force, ref: entry.marketplaceCommit };
}

/**
 * Resolve a GitHub-URL argument into {@link InstallPluginOptions} for an
 * untrusted direct install, or `null` when the URL or flag combination is
 * invalid (a message is printed in that case, and the caller exits non-zero).
 *
 * The marketplace-only flags (`--ref`, `--pin`, `--allow-unreviewed`) do not
 * apply to a direct install — the ref lives in the URL — so combining them is
 * rejected. The install name defaults to the repo / sub-path leaf and can be
 * overridden with `--name`.
 */
function resolveDirectInstallOptions(
  spec: string,
  opts: {
    force?: boolean;
    ref?: string;
    pin?: string;
    allowUnreviewed?: boolean;
    name?: string;
  },
): InstallPluginOptions | null {
  if (opts.ref) {
    console.error(
      "--ref does not apply to a GitHub-URL install; put the ref in the URL (e.g. .../tree/<ref>/...).",
    );
    return null;
  }
  if (opts.pin || opts.allowUnreviewed) {
    console.error(
      "--pin and --allow-unreviewed only apply to marketplace installs by name, not a GitHub URL.",
    );
    return null;
  }

  let parsed;
  try {
    parsed = parseGitHubPluginSpec(spec);
  } catch (err) {
    if (err instanceof InvalidGitHubPluginSpecError) {
      console.error(err.message);
      return null;
    }
    throw err;
  }

  const requested = opts.name ?? parsed.defaultName;
  let name: string;
  try {
    name = sanitizePluginName(requested);
  } catch (err) {
    if (err instanceof InvalidPluginNameError) {
      console.error(
        opts.name
          ? err.message
          : `Could not derive a valid plugin name from "${parsed.defaultName}". ` +
              "Pass --name <name> to choose one (lowercase letters, digits, '-', '_').",
      );
      return null;
    }
    throw err;
  }

  const directSource: PluginFetchSource = {
    owner: parsed.owner,
    repo: parsed.repo,
    rootPath: parsed.path,
    ref: parsed.ref,
  };
  return { name, force: opts.force ?? false, directSource };
}

/**
 * Print a prominent yellow warning before an untrusted direct install. Such a
 * plugin is not in the curated marketplace, has not been reviewed, and its
 * hooks/tools run inside the assistant with full access — so the user must
 * decide whether they trust the source. Goes to stderr so it stays visible
 * alongside (not interleaved with) the stdout result line.
 */
function printUntrustedPluginWarning(
  name: string,
  source: PluginFetchSource,
): void {
  const location = source.rootPath
    ? `${source.owner}/${source.repo}/${source.rootPath}`
    : `${source.owner}/${source.repo}`;
  const ref = source.ref === DEFAULT_DIRECT_REF ? "default branch" : source.ref;
  const lines = [
    `⚠ Installing "${name}" from an unreviewed GitHub source: ${location} @ ${ref}.`,
    "  This plugin is NOT in the Vellum marketplace and has not been reviewed.",
    "  Its hooks and tools run inside the assistant with full access — install it only if you trust the source.",
  ];
  console.error(yellow(lines.join("\n")));
}

/**
 * Render a plugin's marketplace-pin history as a table: the pinned commit (short
 * SHA), when it was promoted, and a marker for the pin currently active. An
 * empty history reports that none was found.
 */
function formatVersions(
  name: string,
  history: readonly PluginPinHistoryEntry[],
): string[] {
  if (history.length === 0) {
    return [`No marketplace pin history found for "${name}".`];
  }
  const rows = history.map((entry) => ({
    pin: shortSha(entry.pin),
    promoted: formatTimestamp(entry.promotedAt),
    marker: entry.current ? "(current)" : "",
  }));
  const pinW = Math.max(3, ...rows.map((r) => r.pin.length));
  const promotedW = Math.max(8, ...rows.map((r) => r.promoted.length));
  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  const lines = [
    `${pad("PIN", pinW)}  ${pad("PROMOTED", promotedW)}  `.trimEnd(),
  ];
  for (const r of rows) {
    lines.push(
      `${pad(r.pin, pinW)}  ${pad(r.promoted, promotedW)}  ${r.marker}`.trimEnd(),
    );
  }
  lines.push("");
  lines.push("Install an older pin with:");
  lines.push(`  assistant plugins install ${name} --pin <sha> --force`);
  return lines;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

/**
 * Render a commit timestamp as the human-facing version: a UTC `YYYY-MM-DDThh:mm:ss`
 * string (seconds precision, no fractional or zone suffix). Older installs with
 * no recorded commit date — and remote pins whose date could not be fetched —
 * fall back to `unknown`, with the SHA still shown alongside as the precise id.
 */
function formatTimestamp(iso: string | null): string {
  if (!iso) return "unknown";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  return new Date(ms).toISOString().slice(0, 19);
}

/**
 * Build a human-readable status string for a plugin in the `--all` listing.
 * Combines disabled state with any structural issues.
 */
function formatAllPluginStatus(p: AllPluginInfo): string {
  const parts: string[] = [];
  if (p.disabled) parts.push("disabled");
  if (p.issues.length > 0) parts.push(p.issues.join("; "));
  if (parts.length === 0) parts.push("enabled");
  return parts.join(", ");
}

/** Human-readable status line for an inspection result. The from/to revisions
 * now live in the installed/remote blocks, so the status itself is just words. */
function statusLine(status: PluginInspection["status"]): string {
  switch (status) {
    case "up-to-date":
      return "up to date";
    case "update-available":
      return "update available";
    case "not-installed":
      return "not installed";
    case "not-in-marketplace":
      return "installed (not in marketplace)";
    case "unknown-provenance":
      return "unknown (reinstall to record provenance)";
    case "remote-unavailable":
      return "installed (marketplace unavailable)";
  }
}

/**
 * Summarize drift relative to the install-time fingerprint. Reports "unknown"
 * when no baseline was recorded (an older or manually-copied install), "none"
 * when the on-disk tree matches, or a per-category count.
 */
function driftLine(changes: FingerprintComparison | null): string {
  if (!changes)
    return "unknown (no recorded baseline; reinstall to record one)";
  if (changes.clean) return "none";
  const parts = [
    `${changes.modified.length} modified`,
    `${changes.added.length} added`,
    `${changes.removed.length} removed`,
  ];
  return parts.join(", ");
}

/** Build the GitHub web URL for a remote pin's location (repo, or repo subtree). */
function remoteLocation(remote: PluginRemoteInfo): string {
  const base = `https://github.com/${remote.repo}`;
  return remote.path ? `${base}/tree/${remote.commit}/${remote.path}` : base;
}

/**
 * Render an inspection with timestamps as the headline version. The layout is a
 * name heading + rule, a top-level `status`, then `installed`/`remote` blocks
 * that each carry `timestamp` (the human version), `hash` (the precise id), and
 * `location`, with a `drift` line under the installed copy.
 */
function formatInspection(inspection: PluginInspection): string[] {
  const { name, status, local, remote, remoteError, surfaces } = inspection;
  const lines: string[] = [name, "─".repeat(44)];
  const topRow = (label: string, value: string) =>
    lines.push(`${label.padEnd(11)} ${value}`);
  const blockRow = (label: string, value: string) =>
    lines.push(`  ${label.padEnd(9)} ${value}`);
  // A surface block: the surface type as a heading, then its items indented
  // under it. Omitted entirely when the plugin contributes none of that type,
  // so the listing only ever shows what the plugin actually contributes.
  const surfaceBlock = (label: string, items: readonly string[]) => {
    if (items.length === 0) return;
    lines.push(label);
    for (const item of items) lines.push(`  ${item}`);
  };

  topRow("status", statusLine(status));

  if (local) {
    lines.push("installed");
    blockRow("timestamp", formatTimestamp(local.committedAt));
    blockRow("hash", shortSha(local.commit));
    blockRow("location", local.target);
    // `installedAt` is rewritten on every install/upgrade, so it reads as the
    // last time this copy was materialized rather than a first-install date.
    blockRow("updated", formatTimestamp(local.installedAt));
    topRow("drift", driftLine(local.localChanges));
  }

  if (remote) {
    lines.push("remote");
    blockRow("timestamp", formatTimestamp(remote.committedAt));
    blockRow("hash", shortSha(remote.commit));
    blockRow("location", remoteLocation(remote));
  } else if (remoteError) {
    topRow("remote", `unavailable: ${remoteError}`);
  }

  const pkgVersion = local?.version ?? null;
  if (pkgVersion) topRow("pkg version", pkgVersion);

  const license = remote?.license ?? null;
  const homepage = remote?.homepage ?? null;
  if (license) topRow("license", license);
  if (homepage) topRow("homepage", homepage);

  const description = remote?.description ?? local?.description ?? null;
  if (description) topRow("description", description);

  if (surfaces) {
    surfaceBlock("skills", surfaces.skills);
    surfaceBlock("hooks", surfaces.hooks);
    surfaceBlock("tools", surfaces.tools);
  }

  for (const issue of local?.issues ?? []) topRow("issue", issue);

  return lines;
}

/**
 * Render an upgrade result with the `timestamp (hash) → timestamp (hash)` move
 * as the headline, mirroring the inspect layout so the same version identity is
 * used everywhere.
 */
function formatUpgrade(result: PluginUpgradeResult): string[] {
  const { name, fromCommit, fromTimestamp, toCommit, toTimestamp } = result;
  const move =
    `${formatTimestamp(fromTimestamp)} (${shortSha(fromCommit)})` +
    ` → ${formatTimestamp(toTimestamp)} (${shortSha(toCommit)})`;
  const provenanceNote = result.provenanceWasUnknown
    ? "Previous install had no recorded provenance; it has been re-pinned."
    : null;

  switch (result.outcome) {
    case "already-up-to-date":
      return [
        `"${name}" is already up to date at ${formatTimestamp(toTimestamp)} (${shortSha(toCommit)}).`,
      ];
    case "would-upgrade": {
      const lines = [
        `"${name}" would upgrade ${move}`,
        "",
        "dry run; no changes made.",
      ];
      if (provenanceNote) lines.push(provenanceNote);
      return lines;
    }
    case "upgraded": {
      const count =
        result.fileCount === null
          ? ""
          : `(${result.fileCount} file${result.fileCount === 1 ? "" : "s"}) `;
      const hasConflicts =
        result.conflicts.length > 0 || result.binaryConflicts.length > 0;

      // Under `assistant`, an unresolved merge leaves conflicts in the tree —
      // the plugin would fail to load while any remain, so the usual "restart
      // now" guidance is replaced with resolution instructions. Most conflicts
      // carry git markers, but a modify/delete divergence (a file edited on one
      // side and deleted on the other) keeps the surviving content with no
      // markers, so the guidance covers both rather than assuming markers.
      if (result.strategy === "assistant" && hasConflicts) {
        const lines = [
          `Merged "${name}" ${move} with conflicts`,
          "",
          `${count}→ ${result.target}`,
        ];
        if (result.conflicts.length > 0) {
          lines.push(
            "",
            `Resolve ${result.conflicts.length} conflicted file${result.conflicts.length === 1 ? "" : "s"} (open each: resolve its git conflict markers, or — if a modify/delete divergence kept the file with none — decide whether to keep or remove it):`,
            ...result.conflicts.map((p) => `  ${p}`),
          );
        }
        if (result.binaryConflicts.length > 0) {
          lines.push(
            "",
            `Binary conflict${result.binaryConflicts.length === 1 ? "" : "s"} (kept the local copy — choose a version manually):`,
            ...result.binaryConflicts.map((p) => `  ${p}`),
          );
        }
        lines.push(
          "",
          "Resolve the conflicts, then restart the assistant to pick up the upgrade.",
        );
        if (provenanceNote) lines.push(provenanceNote);
        return lines;
      }

      const mergeNote =
        result.strategy === "ours" || result.strategy === "theirs"
          ? `Local edits were merged (--strategy ${result.strategy}).`
          : result.strategy === "assistant"
            ? "Local edits were merged with no conflicts (--strategy assistant)."
            : null;
      const lines = [
        `Upgraded "${name}" ${move}`,
        "",
        `${count}→ ${result.target}`,
        "Restart the assistant to pick up the upgrade.",
      ];
      if (mergeNote) lines.push(mergeNote);
      if (provenanceNote) lines.push(provenanceNote);
      return lines;
    }
  }
}

/**
 * Render a diff result: a one-line "no local changes" when clean, otherwise a
 * header naming the install-commit baseline followed by each file's unified
 * diff (blank-line separated, mirroring how `git diff` stacks file patches).
 */
function formatDiff(result: PluginDiffResult): string[] {
  const baseline = `${formatTimestamp(result.committedAt)} (${shortSha(result.commit)})`;
  if (result.clean) {
    return [
      `"${result.name}" has no local changes (matches install commit ${baseline}).`,
    ];
  }
  const count = result.files.length;
  const lines = [
    `"${result.name}" — ${count} file${count === 1 ? "" : "s"} changed vs install commit ${baseline}`,
    "",
  ];
  for (const file of result.files) {
    // A non-reconstructed baseline carries an explanatory marker, not a patch
    // with `a/`–`b/` headers, so name the file it refers to.
    if (!file.reconstructed) {
      lines.push(`${file.path}: ${file.diff.trimEnd()}`, "");
      continue;
    }
    lines.push(file.diff.trimEnd(), "");
  }
  return lines;
}
