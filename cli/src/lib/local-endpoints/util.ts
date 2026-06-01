import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const CLI_PACKAGE_NAME = "@vellumai/cli";

const SENSITIVE_FIELDS = [
  "signingKey",
  "bearerToken",
  "guardianBootstrapSecret",
] as const;

export function stripSensitiveFields(data: Record<string, unknown>): void {
  const assistants = data.assistants;
  if (!Array.isArray(assistants)) return;
  for (const assistant of assistants) {
    if (assistant && typeof assistant === "object") {
      const entry = assistant as Record<string, unknown>;
      for (const field of SENSITIVE_FIELDS) {
        delete entry[field];
      }
      const resources = entry.resources;
      if (resources && typeof resources === "object") {
        for (const field of SENSITIVE_FIELDS) {
          delete (resources as Record<string, unknown>)[field];
        }
      }
    }
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
export function resolveCliPath(baseDir: string, importMetaUrl?: string): string {
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

export function resetCliPathCache(): void {
  _resolvedCliPath = undefined;
}
