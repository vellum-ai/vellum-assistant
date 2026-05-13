/**
 * `assistant plugins` — manage external plugins installed under
 * `<workspaceDir>/plugins/`.
 *
 * Gated by the `external-plugins` feature flag. Today the only subcommand
 * is `install`, which materializes a plugin from
 * `vellum-ai/vellum-assistant/experimental/plugins/<name>/` on GitHub into
 * the local workspace plugins directory so the daemon discovers it on
 * next start.
 *
 * The plugin source path is intentionally fixed at the canonical location
 * inside this monorepo. End users on a released binary can install
 * plugins by name without needing a local checkout of the assistant
 * source tree.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Command } from "commander";

import { getWorkspacePluginsDir } from "../../util/platform.js";
import { registerCommand } from "../lib/register-command.js";
import { getCliLogger } from "../logger.js";

const log = getCliLogger("plugins");

/** Where canonical plugin sources live. */
const PLUGIN_SOURCE_OWNER = "vellum-ai";
const PLUGIN_SOURCE_REPO = "vellum-assistant";
const PLUGIN_SOURCE_PATH_PREFIX = "experimental/plugins";
const DEFAULT_REF = "main";

/** Entry shape returned by the GitHub Contents API for a directory listing. */
interface GitHubContentEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "dir" | "symlink" | "submodule";
  readonly size: number;
  readonly download_url: string | null;
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
          `Git ref to fetch from (default: ${DEFAULT_REF})`,
        )
        .action(async (name: string, opts: { force?: boolean; ref?: string }) => {
          await runInstall({
            name,
            force: opts.force ?? false,
            ref: opts.ref ?? DEFAULT_REF,
          });
        });
    },
  });
}

interface InstallArgs {
  readonly name: string;
  readonly force: boolean;
  readonly ref: string;
}

/**
 * Reject plugin names that could escape the canonical source path or the
 * install target. The source convention is a flat namespace under
 * `experimental/plugins/`, so a legitimate name is a single path segment
 * built from kebab-case alphanumerics.
 */
function sanitizeName(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) {
    throw new Error(
      `Invalid plugin name "${name}". Names must match /^[a-z0-9][a-z0-9_-]*$/.`,
    );
  }
  return trimmed;
}

async function runInstall(args: InstallArgs): Promise<void> {
  const name = sanitizeName(args.name);
  const target = join(getWorkspacePluginsDir(), name);

  if (existsSync(target)) {
    if (!args.force) {
      console.error(
        `Plugin "${name}" is already installed at ${target}.\n` +
          `Pass --force to overwrite.`,
      );
      process.exitCode = 1;
      return;
    }
    rmSync(target, { recursive: true, force: true });
  }

  mkdirSync(target, { recursive: true });

  let fileCount = 0;
  try {
    fileCount = await copyTreeFromGitHub({
      sourcePath: `${PLUGIN_SOURCE_PATH_PREFIX}/${name}`,
      ref: args.ref,
      targetDir: target,
    });
  } catch (err) {
    // Roll back the empty target so a failed fetch does not leave a
    // half-installed plugin on disk for the daemon to trip over.
    rmSync(target, { recursive: true, force: true });
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Plugin install failed: ${message}`);
    process.exitCode = 1;
    return;
  }

  if (fileCount === 0) {
    rmSync(target, { recursive: true, force: true });
    console.error(
      `Plugin "${name}" not found at ${PLUGIN_SOURCE_OWNER}/${PLUGIN_SOURCE_REPO}/${PLUGIN_SOURCE_PATH_PREFIX}/${name} (ref ${args.ref}).`,
    );
    process.exitCode = 1;
    return;
  }

  log.info(
    { name, target, fileCount, ref: args.ref },
    "external plugin installed",
  );
  console.log(
    `Installed plugin "${name}" (${fileCount} file${fileCount === 1 ? "" : "s"}) → ${target}`,
  );
  console.log("Restart the assistant to pick up the new plugin.");
}

interface CopyTreeArgs {
  readonly sourcePath: string;
  readonly ref: string;
  readonly targetDir: string;
}

/**
 * Mirror a directory tree from the canonical GitHub repo into a local
 * directory using the Contents API. Returns the number of files written.
 *
 * Unauthenticated fetches against api.github.com are subject to a 60/hr
 * rate limit per IP, but the file downloads themselves go to
 * `raw.githubusercontent.com` which has a much higher cap. A plugin tree
 * is at most a few dozen files in practice, so the dominant cost is the
 * per-directory listing call.
 *
 * Symlinks and submodules are skipped — the daemon-side loader does not
 * follow either, so reproducing them in the install target adds risk
 * without value.
 */
async function copyTreeFromGitHub(args: CopyTreeArgs): Promise<number> {
  return await copyDir(args.sourcePath, args.ref, args.targetDir);
}

async function copyDir(
  apiPath: string,
  ref: string,
  destDir: string,
): Promise<number> {
  const entries = await listDir(apiPath, ref);
  if (entries === null) return 0;

  let count = 0;
  for (const entry of entries) {
    if (entry.type === "dir") {
      const subDest = join(destDir, entry.name);
      mkdirSync(subDest, { recursive: true });
      count += await copyDir(entry.path, ref, subDest);
      continue;
    }
    if (entry.type === "file") {
      await copyFile(entry, destDir);
      count++;
      continue;
    }
    // Skip symlink + submodule deliberately.
  }
  return count;
}

async function listDir(
  apiPath: string,
  ref: string,
): Promise<readonly GitHubContentEntry[] | null> {
  const url =
    `https://api.github.com/repos/${PLUGIN_SOURCE_OWNER}/${PLUGIN_SOURCE_REPO}` +
    `/contents/${encodeURIComponent(apiPath).replaceAll("%2F", "/")}?ref=${encodeURIComponent(ref)}`;

  const res = await githubFetch(url, "application/vnd.github+json");
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `GitHub contents listing failed for ${apiPath} @ ${ref}: HTTP ${res.status}`,
    );
  }

  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) {
    // A non-array body for a /contents/<dir> path means the path is a
    // file, not a directory — i.e. the plugin name resolved to a single
    // file rather than a plugin directory. Treat as not-a-plugin.
    return null;
  }
  return body as readonly GitHubContentEntry[];
}

async function copyFile(
  entry: GitHubContentEntry,
  destDir: string,
): Promise<void> {
  if (!entry.download_url) {
    throw new Error(
      `GitHub contents entry has no download_url: ${entry.path}`,
    );
  }
  const res = await githubFetch(entry.download_url, "application/octet-stream");
  if (!res.ok) {
    throw new Error(
      `Download failed for ${entry.path}: HTTP ${res.status}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = join(destDir, entry.name);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
}

/**
 * Wraps `fetch` with the headers we want to send to GitHub for every
 * request. Honors `GITHUB_TOKEN` when present so users who hit the
 * unauthenticated rate limit can opt into a higher cap.
 *
 * Exposed via the {@link _testHooks} so tests can swap the implementation
 * without touching the live network or monkey-patching globalThis.fetch.
 */
async function githubFetch(url: string, accept: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "vellum-assistant-cli",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return _testHooks.fetch(url, { headers });
}

/**
 * Test seam — exported so the unit suite can replace the network with a
 * fixture without touching `globalThis.fetch`, which is shared across the
 * Bun process and other module imports.
 *
 * Typed against a narrowed `FetchLike` rather than `typeof fetch` because
 * Bun's `fetch` carries a `preconnect` static that the wrapper closure
 * does not — and we have no use for it here.
 */
type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const _testHooks: { fetch: FetchLike } = {
  fetch: ((input, init) => fetch(input, init)) as FetchLike,
};

/** Exported for unit tests; not part of the public CLI surface. */
export const _internals = {
  sanitizeName,
  runInstall,
  copyTreeFromGitHub,
};
