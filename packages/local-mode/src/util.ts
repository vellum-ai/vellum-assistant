import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { SENSITIVE_KEYS } from "./lockfile-contract";

const CLI_PACKAGE_NAME = "@vellumai/cli";

/**
 * How to invoke the Vellum CLI as a child process: a base command plus the
 * leading arguments that precede the subcommand. Each host resolves its own
 * invocation — the dev hosts run the CLI from source via `bun run <entry>`,
 * a packaged host would point at its bundled runtime — and the shared
 * lifecycle ops (`runHatch`, `runRetire`, guardian-token refresh) append
 * their subcommand args to `baseArgs`.
 */
export interface CliInvocation {
  command: string;
  baseArgs: string[];
}

export function stripSensitiveFields(data: Record<string, unknown>): void {
  const assistants = data.assistants;
  if (!Array.isArray(assistants)) return;
  for (const assistant of assistants) {
    if (assistant && typeof assistant === "object") {
      const entry = assistant as Record<string, unknown>;
      for (const field of SENSITIVE_KEYS) {
        delete entry[field];
      }
      const resources = entry.resources;
      if (resources && typeof resources === "object") {
        for (const field of SENSITIVE_KEYS) {
          delete (resources as Record<string, unknown>)[field];
        }
      }
    }
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function headerHostIsLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    return isLoopbackHostname(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

export function originIsAllowed(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  try {
    const origin = new URL(originHeader);
    return (
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      isLoopbackHostname(origin.hostname)
    );
  } catch {
    return false;
  }
}

export function isLoopbackAddr(addr: string): boolean {
  const v4Mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const normalized = v4Mapped ? v4Mapped[1]! : addr;
  if (normalized.includes(".")) {
    return normalized.startsWith("127.");
  }
  return normalized === "::1";
}

let _resolvedCliPath: string | undefined;

/**
 * Resolve the CLI entry point.
 *
 * 1. Source tree — `<baseDir>/cli/src/index.ts` (dev mode in monorepo).
 * 2. Installed package — `require.resolve("@vellumai/cli/package.json")`.
 */
function resolveCliPath(baseDir: string, importMetaUrl?: string): string {
  if (_resolvedCliPath) return _resolvedCliPath;

  const sourceTreePath = path.join(baseDir, "cli", "src", "index.ts");
  if (fs.existsSync(sourceTreePath)) {
    _resolvedCliPath = sourceTreePath;
    return _resolvedCliPath;
  }

  const _require = createRequire(importMetaUrl ?? `file://${baseDir}/`);
  try {
    const pkgPath = _require.resolve(`${CLI_PACKAGE_NAME}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { bin?: Record<string, string> };
    const binEntry = pkg.bin?.["vellum"];
    if (binEntry) {
      const entryPoint = path.resolve(path.dirname(pkgPath), binEntry);
      if (fs.existsSync(entryPoint)) {
        _resolvedCliPath = entryPoint;
        return _resolvedCliPath;
      }
    }
  } catch {
    // Not found in node_modules
  }

  throw new Error(
    `Vellum CLI not found. Looked for source tree at ${sourceTreePath} and npm package ${CLI_PACKAGE_NAME}.`,
  );
}

/**
 * Build the CLI invocation used by the dev hosts (CLI client server and the
 * web dev-server middleware), which run the CLI from source via Bun:
 * `bun run <cli-entry> <subcommand> …`.
 */
export function resolveDevCliInvocation(
  baseDir: string,
  importMetaUrl?: string,
): CliInvocation {
  return { command: "bun", baseArgs: ["run", resolveCliPath(baseDir, importMetaUrl)] };
}
