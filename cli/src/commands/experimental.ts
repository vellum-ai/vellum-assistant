/**
 * `vellum experimental` — namespace for unstable features that may move,
 * rename, or disappear before stabilizing.
 *
 * Current subcommands:
 *
 *   experimental plugins install <source>
 *     Materialize a plugin from a local directory into
 *     `<workspaceDir>/plugins/<name>/` so the daemon's user plugin loader
 *     picks it up on next start.
 *
 * The `experimental` namespace is deliberately separate from top-level
 * commands so users have a clear signal that these surfaces are not
 * stable. When a feature graduates, its CLI form moves out of this
 * namespace; the old form remains for one release as a thin redirect.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import { resolveWorkspacePluginsDir } from "../lib/workspace-dir";

/** Top-level dispatcher for `vellum experimental ...`. */
export async function experimental(): Promise<void> {
  const args = process.argv.slice(3);
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printExperimentalHelp();
    process.exit(sub ? 0 : 1);
  }

  if (sub === "plugins") {
    await experimentalPlugins(args.slice(1));
    return;
  }

  console.error(`Unknown experimental subcommand: ${sub}`);
  printExperimentalHelp();
  process.exit(1);
}

function printExperimentalHelp(): void {
  console.log("Usage: vellum experimental <subcommand>");
  console.log("");
  console.log("Subcommands:");
  console.log("  plugins   Manage experimental plugins");
  console.log("");
  console.log("These surfaces are unstable and may change between releases.");
}

async function experimentalPlugins(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printPluginsHelp();
    process.exit(sub ? 0 : 1);
  }

  if (sub === "install") {
    await pluginsInstall(args.slice(1));
    return;
  }

  console.error(`Unknown experimental plugins subcommand: ${sub}`);
  printPluginsHelp();
  process.exit(1);
}

function printPluginsHelp(): void {
  console.log("Usage: vellum experimental plugins <subcommand>");
  console.log("");
  console.log("Subcommands:");
  console.log("  install <source>   Install a plugin from a local directory");
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

interface InstallOptions {
  readonly source: string;
  readonly force: boolean;
  readonly workspace: string | null;
}

async function pluginsInstall(args: string[]): Promise<void> {
  const opts = parseInstallArgs(args);
  if (!opts) return; // already exited or printed help

  const sourceAbs = isAbsolute(opts.source) ? opts.source : resolve(opts.source);

  if (!existsSync(sourceAbs) || !statSync(sourceAbs).isDirectory()) {
    console.error(`Source is not a directory: ${sourceAbs}`);
    process.exit(1);
  }

  const pkgPath = join(sourceAbs, "package.json");
  if (!existsSync(pkgPath)) {
    console.error(
      `Source is not a plugin: missing package.json at ${pkgPath}`,
    );
    process.exit(1);
  }

  // Reject the legacy `register.{ts,js}` shape — those are not part of the
  // declarative external-plugin surface this CLI installs into. Their
  // discovery path goes through the in-tree `examples/plugins/<name>/`
  // location and a different loader contract.
  for (const legacy of ["register.ts", "register.js"]) {
    if (existsSync(join(sourceAbs, legacy))) {
      console.error(
        `Source uses the legacy ${legacy} entry shape; the install CLI ` +
          `targets the declarative external-plugin surface only.`,
      );
      process.exit(1);
    }
  }

  // Require at least one declarative surface dir so we fail fast on an
  // obviously-misshaped source instead of materializing an empty plugin.
  const hasHooks = existsSync(join(sourceAbs, "hooks"));
  const hasTools = existsSync(join(sourceAbs, "tools"));
  if (!hasHooks && !hasTools) {
    console.error(
      `Source has no hooks/ or tools/ directory; nothing to install ` +
        `from ${sourceAbs}.`,
    );
    process.exit(1);
  }

  const name = readPluginName(pkgPath);
  if (!name) process.exit(1); // readPluginName already reported

  const pluginsRoot = opts.workspace ?? resolveWorkspacePluginsDir();
  const target = join(pluginsRoot, name);

  if (existsSync(target)) {
    if (!opts.force) {
      console.error(
        `Target already exists: ${target}\n` +
          `Pass --force to overwrite.`,
      );
      process.exit(1);
    }
    rmSync(target, { recursive: true, force: true });
  }

  mkdirSync(pluginsRoot, { recursive: true });

  // Copy recursively, skipping `node_modules` so we don't drag a
  // developer's local install graph into the installed plugin. The
  // daemon's external loader does not depend on `node_modules` being
  // present at the plugin root.
  cpSync(sourceAbs, target, {
    recursive: true,
    filter: (src) => {
      const segment = basename(src);
      if (segment === "node_modules") return false;
      return true;
    },
  });

  console.log(`Installed plugin "${name}" → ${target}`);
  console.log("Restart the assistant to pick up the new plugin.");
}

function parseInstallArgs(args: string[]): InstallOptions | null {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum experimental plugins install <source> [options]");
    console.log("");
    console.log(
      "Materialize a plugin from a local directory into",
    );
    console.log(
      "  <workspaceDir>/plugins/<name>/ — the location the daemon's user",
    );
    console.log("  plugin loader scans on startup.");
    console.log("");
    console.log("Arguments:");
    console.log("  <source>             Path to the plugin source directory");
    console.log("");
    console.log("Options:");
    console.log("  --force              Overwrite an existing install");
    console.log(
      "  --workspace <dir>    Override the plugins root (defaults to",
    );
    console.log(
      "                         VELLUM_WORKSPACE_DIR/plugins or",
    );
    console.log("                         ~/.vellum/workspace/plugins)");
    console.log("");
    console.log("The source directory must contain a package.json and at");
    console.log("least one of hooks/ or tools/. Legacy register.{ts,js}");
    console.log("plugins are rejected — this CLI installs only declarative");
    console.log("external-plugin sources.");
    process.exit(args.length === 0 ? 1 : 0);
  }

  let source: string | null = null;
  let force = false;
  let workspace: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--workspace") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        console.error("--workspace requires a directory argument");
        process.exit(1);
      }
      workspace = next;
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
    if (source !== null) {
      console.error(
        `Unexpected extra argument: ${arg} (source already set to ${source})`,
      );
      process.exit(1);
    }
    source = arg;
  }

  if (!source) {
    console.error("Missing required argument: <source>");
    process.exit(1);
  }

  return { source, force, workspace };
}

/**
 * Read the source plugin's `package.json` and return its install name
 * (scope stripped). Mirrors the daemon-side `stripScope` in
 * `assistant/src/plugins/external-plugin-loader.ts` so installed and
 * loaded names agree.
 */
function readPluginName(pkgPath: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch (err) {
    console.error(
      `Could not parse ${pkgPath}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { name?: unknown }).name !== "string"
  ) {
    console.error(`package.json at ${pkgPath} has no string "name" field`);
    return null;
  }

  const raw = (parsed as { name: string }).name.trim();
  if (!raw) {
    console.error(`package.json at ${pkgPath} has an empty "name" field`);
    return null;
  }

  const scopeMatch = /^@[^/]+\/(.+)$/.exec(raw);
  return scopeMatch ? scopeMatch[1]! : raw;
}
