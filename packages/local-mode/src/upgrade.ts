import { spawn } from "node:child_process";

import type { CliInvocation } from "./util";

const UPGRADE_TIMEOUT_MS = 20 * 60 * 1000;

export type UpgradeResult =
  | { ok: true; version?: string }
  | { ok: false; status: number; error: string };

export interface UpgradeOptions {
  version?: string;
  latest?: boolean;
  force?: boolean;
}

// A trusted release version is the literal `latest` dist-tag, or a
// version-shaped string: an optional `v`/`V` prefix, then a leading digit,
// then any run of `[0-9A-Za-z.+-]`. This is intentionally lenient about the
// *shape* of the version (2-, 3-, or 4-part, arbitrary pre-release/build
// identifiers, uppercase `V`) so we never reject a legitimate release tag.
//
// Security does not depend on the shape — it depends on the CHARSET. The
// allowed set excludes `/`, `\`, `:`, `@`, `#` and whitespace, so the value can
// never be interpreted by `bun install` as a package-manager spec (npm alias,
// tarball/git URL, `file:`/`github:` ref) — all of which require one of those
// characters. The mandatory leading digit means the value can never be a bare
// `.`/`..` path segment, and `..` is rejected outright, so the version is safe
// to use as the runtime-install directory name.
const RELEASE_VERSION_PATTERN = /^(?:latest|[vV]?\d[0-9A-Za-z.+-]*)$/;

/**
 * Whether `version` is a trusted release identifier: the literal `latest`, or a
 * version-shaped tag like `v1.2.3` / `1.2.3` / `0.6.0-staging.5`. Rejects
 * package-manager specifiers (npm aliases, tarball or git URLs) and any
 * path-traversal-like input, while staying permissive about semver shape.
 *
 * Defined once here and reused by both the host-bridge boundary guard
 * (`runUpgrade`, in the shared library backing the Electron host and the web
 * dev-server middleware) and the CLI's runtime-install sink
 * (`ensureLocalRuntime`), so the security boundary can never drift between the
 * two call sites.
 */
export function isValidReleaseVersion(version: string): boolean {
  return RELEASE_VERSION_PATTERN.test(version) && !version.includes("..");
}

function extractVersion(output: string): string | undefined {
  const versionPattern = "(v?[0-9]+(?:\\.[0-9]+)*(?:[-+][\\w.-]+)?)";
  const upgraded = output.match(
    new RegExp(`\\bupgraded to\\s+${versionPattern}`, "i"),
  )?.[1];
  if (upgraded) return upgraded;

  return output.match(new RegExp(`\\bAlready on\\s+${versionPattern}`, "i"))?.[1];
}

/**
 * Upgrade a local assistant via the CLI. The CLI owns the full lifecycle
 * (backup, process restart, health wait, rollback on failure); the host
 * bridge only starts it and returns the structured result to the renderer.
 */
export function runUpgrade(
  invocation: CliInvocation,
  assistantId: string,
  options?: UpgradeOptions,
): Promise<UpgradeResult> {
  return new Promise((resolve) => {
    // Reject an untrusted `--version` at the host boundary before spawning the
    // CLI. `latest` (or the `--latest` flag) is always allowed; an explicit
    // version must be a release tag. Preserves the never-reject contract.
    if (options?.version && !isValidReleaseVersion(options.version)) {
      resolve({
        ok: false,
        status: 400,
        error: `Invalid upgrade version '${options.version}': expected a release tag like v1.2.3 or 'latest'.`,
      });
      return;
    }

    const args = [...invocation.baseArgs, "upgrade", assistantId];
    if (options?.latest) {
      args.push("--latest");
    } else if (options?.version) {
      args.push("--version", options.version);
    }
    if (options?.force) {
      args.push("--force");
    }

    const child = spawn(invocation.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: UpgradeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        status: 500,
        error: `Upgrade timed out after ${UPGRADE_TIMEOUT_MS / 1000} seconds`,
      });
    }, UPGRADE_TIMEOUT_MS);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        const version = extractVersion(stdout);
        finish(version ? { ok: true, version } : { ok: true });
        return;
      }

      finish({
        ok: false,
        status: 500,
        error:
          stderr.trim() ||
          stdout.trim() ||
          `Upgrade failed: the CLI exited with code ${code ?? "unknown"} and produced no output.`,
      });
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        status: 500,
        error: `Failed to spawn CLI: ${err.message}`,
      });
    });
  });
}
