/**
 * `assistant plugins publish` — validate a local plugin, resolve its git
 * context, and submit it to the Vellum marketplace catalog via the platform
 * API.
 *
 * The flow mirrors `npm publish`: validate the package locally, resolve the
 * version (commit SHA), and POST to a registry endpoint. The platform then
 * creates a pull request against `vellum-ai/vellum-assistant` using the
 * Vellum Automation GitHub App.
 *
 * Designed for direct programmatic use with an injected `fetch`, mirroring
 * {@link ./install-from-github} and {@link ./search-plugins}.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { MarketplaceEntry } from "./plugin-marketplace.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PublishValidation {
  valid: boolean;
  issues: string[];
  warnings: string[];
  packageJson: ParsedPackageJson;
  pluginDir: string;
}

export interface ParsedPackageJson {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  homepage?: string;
  repository?: string | { url?: string };
  peerDependencies?: Record<string, string>;
}

export interface GitContext {
  sha: string;
  repo: string;
  dirty: boolean;
  pushed: boolean;
}

export interface PublishPayload {
  name: string;
  source: {
    source: "github";
    repo: string;
    ref: string;
    path?: string;
  };
  description?: string;
  category?: string;
  homepage?: string;
  license?: string;
}

export interface PublishResult {
  ok: boolean;
  pr_url?: string;
  pr_number?: number;
  status?: string;
  error?: string;
  message?: string;
}

export interface PublishDeps {
  fetch: typeof globalThis.fetch;
  platformBaseUrl: string;
  apiKey: string;
}

// ---------------------------------------------------------------------------
// Plugin discovery + validation
// ---------------------------------------------------------------------------

/**
 * Walk up from `startDir` to find the nearest directory containing a
 * `package.json`. Returns the directory path, or `null` if none is found
 * before reaching the filesystem root.
 */
export function findPluginRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Validate a plugin directory for publish readiness.
 *
 * Checks the same things the review team will verify:
 * - package.json exists with name, version, and @vellumai/plugin-api peer dep
 * - At least one surface directory (hooks/, tools/, skills/) has entries
 * - No stale .js artifacts without matching .ts source
 */
export function validatePluginForPublish(dir: string): PublishValidation {
  const issues: string[] = [];
  const warnings: string[] = [];

  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    return {
      valid: false,
      issues: ["package.json not found"],
      warnings: [],
      packageJson: {},
      pluginDir: dir,
    };
  }

  let pkg: ParsedPackageJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return {
      valid: false,
      issues: ["package.json is not valid JSON"],
      warnings: [],
      packageJson: {},
      pluginDir: dir,
    };
  }

  if (!pkg.name) {
    issues.push("package.json missing 'name' field");
  } else if (!/^[a-z0-9][a-z0-9_-]*$/.test(pkg.name)) {
    issues.push(
      `name "${pkg.name}" is not kebab-case (expected /^[a-z0-9][a-z0-9_-]*$/)`,
    );
  }

  if (!pkg.version) {
    issues.push("package.json missing 'version' field");
  }

  const peerDeps = pkg.peerDependencies ?? {};
  if (!("@vellumai/plugin-api" in peerDeps)) {
    issues.push(
      "package.json missing peerDependencies['@vellumai/plugin-api']",
    );
  }

  // Check for at least one surface directory with entries
  const surfaceDirs = ["hooks", "tools", "skills"];
  const hasAnySurface = surfaceDirs.some((d) => {
    const dirPath = join(dir, d);
    return existsSync(dirPath) && readdirSync(dirPath).length > 0;
  });
  if (!hasAnySurface) {
    warnings.push(
      "No hooks/, tools/, or skills/ directories with entries found. The plugin may not contribute any surfaces.",
    );
  }

  // Check for stale .js without matching .ts
  for (const d of surfaceDirs) {
    const dirPath = join(dir, d);
    if (!existsSync(dirPath)) continue;
    for (const file of readdirSync(dirPath)) {
      if (file.endsWith(".js") && !file.endsWith(".d.ts")) {
        const tsFile = file.replace(/\.js$/, ".ts");
        if (!existsSync(join(dirPath, tsFile))) {
          warnings.push(`Stale .js found without matching .ts: ${d}/${file}`);
        }
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
    packageJson: pkg,
    pluginDir: dir,
  };
}

// ---------------------------------------------------------------------------
// Git context resolution
// ---------------------------------------------------------------------------

async function runGit(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout.trim();
}

/**
 * Resolve git context for a plugin directory: the current commit SHA,
 * the GitHub remote (owner/repo), whether the working tree is dirty,
 * and whether the commit has been pushed to the remote.
 */
export async function resolveGitContext(dir: string): Promise<GitContext> {
  const sha = await runGit(dir, ["rev-parse", "HEAD"]);

  let dirty = false;
  try {
    const status = await runGit(dir, ["status", "--porcelain"]);
    dirty = status.length > 0;
  } catch {
    // If git status fails, assume clean (not critical)
  }

  // Find the GitHub remote
  const remoteOutput = await runGit(dir, ["remote", "-v"]);
  const remoteMatch = remoteOutput.match(
    /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s/m,
  );
  if (!remoteMatch) {
    throw new Error(
      "No GitHub remote found. The plugin must be pushed to a public GitHub repository.",
    );
  }
  const repo = remoteMatch[1];

  // Check if the commit is pushed
  let pushed = true;
  try {
    const result = await runGit(dir, ["ls-remote", "origin", sha]);
    pushed = result.length > 0;
  } catch {
    // If ls-remote fails (e.g. no network), assume pushed to avoid blocking
    pushed = true;
  }

  return { sha, repo, dirty, pushed };
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the publish payload from validated plugin data and git context.
 * Auto-populates fields from package.json and fills in the git-resolved
 * source coordinates.
 */
export function buildPublishPayload(
  validation: PublishValidation,
  git: GitContext,
  category: string,
): PublishPayload {
  const pkg = validation.packageJson;
  const homepage = pkg.homepage ?? extractRepoUrl(pkg);

  const payload: PublishPayload = {
    name: pkg.name!,
    source: {
      source: "github",
      repo: git.repo,
      ref: git.sha,
    },
    category,
  };

  if (pkg.description) payload.description = pkg.description;
  if (pkg.license) payload.license = pkg.license;
  if (homepage) payload.homepage = homepage;

  return payload;
}

function extractRepoUrl(pkg: ParsedPackageJson): string | undefined {
  if (!pkg.repository) return undefined;
  if (typeof pkg.repository === "string") {
    // shorthand: "github:owner/repo" or URL
    const match = pkg.repository.match(
      /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/,
    );
    return match ? `https://github.com/${match[1]}` : undefined;
  }
  if (pkg.repository.url) {
    const match = pkg.repository.url.match(
      /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/,
    );
    return match ? `https://github.com/${match[1]}` : pkg.repository.url;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Platform API submission
// ---------------------------------------------------------------------------

/**
 * POST the publish payload to the Vellum platform API.
 */
export async function postPublishRequest(
  payload: PublishPayload,
  deps: PublishDeps,
): Promise<PublishResult> {
  const resp = await deps.fetch(
    `${deps.platformBaseUrl.replace(/\/+$/, "")}/v1/plugins/publish`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Api-Key ${deps.apiKey}`,
      },
      body: JSON.stringify(payload),
    },
  );

  const data = (await resp.json()) as PublishResult;
  return data;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a publish payload as a JSON string for `--print` mode.
 */
export function formatPayloadForPrint(payload: PublishPayload): string {
  return JSON.stringify(payload, null, 2);
}

/**
 * Format validation results for terminal output.
 */
export function formatValidationResult(validation: PublishValidation): string {
  const lines: string[] = [];

  if (validation.issues.length > 0) {
    lines.push("Validation errors:");
    for (const issue of validation.issues) {
      lines.push(`  ✗ ${issue}`);
    }
  }

  if (validation.warnings.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Warnings:");
    for (const warning of validation.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
  }

  if (validation.valid && validation.warnings.length === 0) {
    lines.push("✓ Plugin validation passed");
  }

  return lines.join("\n");
}

/**
 * Format a publish result for terminal output.
 */
export function formatPublishResult(result: PublishResult): string {
  if (!result.ok) {
    return `✗ Publish failed: ${result.message ?? result.error ?? "unknown error"}`;
  }

  const lines: string[] = [
    `✓ PR opened: ${result.pr_url}`,
    "",
    "The Vellum team will review your plugin. The review checks:",
    "  • Pinned commit is reachable and public",
    "  • package.json has @vellumai/plugin-api peer dependency",
    "  • Plugin loads cleanly (hooks register, tools validate)",
    "  • Surfaces contribute on boot (not silently failing)",
    "",
    "You'll get a notification when the review is complete.",
  ];

  return lines.join("\n");
}
