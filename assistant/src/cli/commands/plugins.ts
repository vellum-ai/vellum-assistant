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
  inspectPlugin,
  type PluginInspection,
  PluginInspectNotFoundError,
  type PluginRemoteInfo,
} from "../lib/inspect-plugin.js";
import {
  DEFAULT_PLUGIN_REF,
  installPlugin,
  InvalidPluginNameError,
  PluginAlreadyInstalledError,
  PluginNotFoundError,
} from "../lib/install-from-github.js";
import { listInstalledPlugins } from "../lib/list-installed-plugins.js";
import type { FingerprintComparison } from "../lib/plugin-fingerprint.js";
import { registerCommand } from "../lib/register-command.js";
import {
  InvalidSearchPatternError,
  searchPlugins,
} from "../lib/search-plugins.js";
import {
  PluginNotInstalledError,
  uninstallPlugin,
} from "../lib/uninstall-plugin.js";
import {
  PluginNotUpgradableError,
  type PluginUpgradeResult,
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
  $ assistant plugins install example --ref my-feature-branch
  $ assistant plugins list
  $ assistant plugins list --json
  $ assistant plugins inspect example
  $ assistant plugins inspect example --json
  $ assistant plugins upgrade example
  $ assistant plugins upgrade example --dry-run
  $ assistant plugins search example
  $ assistant plugins search "^example"
  $ assistant plugins search example --json
  $ assistant plugins uninstall example`,
      );

      plugins
        .command("install <name>")
        .description(
          "Install a plugin from the curated plugins/marketplace.json catalog",
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
        .command("inspect <name>")
        .description(
          "Show a plugin's local install metadata and the marketplace pin, and whether an update is available",
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

      plugins
        .command("upgrade <name>")
        .description(
          "Upgrade an installed plugin to the marketplace's current pin",
        )
        .option(
          "--dry-run",
          "Show what would change without modifying the install",
        )
        .option("--json", "Emit machine-readable JSON instead of a summary")
        .action(
          async (name: string, opts: { dryRun?: boolean; json?: boolean }) => {
            try {
              const result = await upgradePlugin(
                { name, dryRun: opts.dryRun },
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
  const { name, status, local, remote, remoteError } = inspection;
  const lines: string[] = [name, "─".repeat(44)];
  const topRow = (label: string, value: string) =>
    lines.push(`${label.padEnd(11)} ${value}`);
  const blockRow = (label: string, value: string) =>
    lines.push(`  ${label.padEnd(9)} ${value}`);

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
      const lines = [
        `Upgraded "${name}" ${move}`,
        "",
        `${count}→ ${result.target}`,
        "Restart the assistant to pick up the upgrade.",
      ];
      if (provenanceNote) lines.push(provenanceNote);
      return lines;
    }
  }
}
