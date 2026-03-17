import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getRootDir } from "../../util/platform.js";

export interface BrowserRuntimeStatus {
  playwrightAvailable: boolean;
  chromiumInstalled: boolean;
  chromiumPath: string | null;
  error: string | null;
}

/**
 * Resolve playwright's chromium export from a module namespace object,
 * handling CJS→ESM interop where named exports may land under .default.
 */
function resolveChromium(
  pw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (pw.chromium) return pw;
  const def = pw.default as Record<string, unknown> | undefined;
  if (def?.chromium) return def;
  return undefined;
}

/**
 * Try importing playwright from the bundled binary. Returns the module
 * if chromium is resolvable, otherwise undefined. This never installs
 * anything - safe for diagnostic/read-only use.
 */
async function tryBundledPlaywright(): Promise<
  typeof import("playwright") | undefined
> {
  try {
    const pw = await import("playwright");
    const mod = resolveChromium(pw as unknown as Record<string, unknown>);
    if (mod?.chromium) return mod as unknown as typeof import("playwright");
  } catch {
    // Bundled import failed entirely
  }
  return undefined;
}

/**
 * Resolve the package entry point from its package.json exports/main fields.
 */
function resolvePackageEntry(pkgDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
    // Prefer ESM entry from exports map
    const exportsRoot = pkg.exports?.["."];
    if (typeof exportsRoot === "object" && exportsRoot?.import) {
      return join(pkgDir, exportsRoot.import);
    }
    if (pkg.module) return join(pkgDir, pkg.module);
    if (pkg.main) return join(pkgDir, pkg.main);
  } catch {
    // Fall through to default
  }
  return join(pkgDir, "index.mjs");
}

/**
 * Import playwright, falling back to a runtime-installed copy if the
 * bundled import fails (compiled Bun binaries can't initialize
 * playwright's in-process client/server bridge correctly).
 */
export async function importPlaywright(): Promise<typeof import("playwright")> {
  // Try bundled import (works in dev/source mode)
  const bundled = await tryBundledPlaywright();
  if (bundled) return bundled;

  // Compiled binary fallback: install playwright to disk and import
  // from an absolute path so the JS runtime resolves it from the
  // filesystem instead of the compiled module cache.
  // Use the internal assistant root (outside tool sandbox working dir)
  // so untrusted workspace writes cannot plant a forged playwright package.
  const externalDir = join(getRootDir(), "external");
  const pwPkg = join(externalDir, "node_modules", "playwright");

  if (!existsSync(join(pwPkg, "package.json"))) {
    mkdirSync(externalDir, { recursive: true });
    if (!existsSync(join(externalDir, "package.json"))) {
      writeFileSync(join(externalDir, "package.json"), '{"private":true}\n');
    }
    const proc = Bun.spawn(["bun", "add", "playwright"], {
      cwd: externalDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to install playwright: ${stderr}`);
    }
  }

  // Dynamic import with a runtime-computed path - bun can't statically
  // analyze this, so it resolves from the filesystem at runtime.
  const entryPath = resolvePackageEntry(pwPkg);
  const pw: Record<string, unknown> = await import(entryPath);
  const mod = resolveChromium(pw);
  if (!mod?.chromium) {
    throw new Error(
      "Failed to resolve Playwright chromium from runtime-installed copy",
    );
  }
  return mod as unknown as typeof import("playwright");
}

export async function checkBrowserRuntime(): Promise<BrowserRuntimeStatus> {
  // Diagnostic only - no side effects (no playwright installation)
  let chromium: { executablePath: () => string };
  try {
    const pw = await tryBundledPlaywright();
    if (!pw) {
      return {
        playwrightAvailable: false,
        chromiumInstalled: false,
        chromiumPath: null,
        error: "playwright package not available",
      };
    }
    chromium = pw.chromium;
  } catch {
    return {
      playwrightAvailable: false,
      chromiumInstalled: false,
      chromiumPath: null,
      error: "playwright package not available",
    };
  }

  // Check if Chromium browser is installed
  try {
    const execPath = chromium.executablePath();
    const installed = existsSync(execPath);
    return {
      playwrightAvailable: true,
      chromiumInstalled: installed,
      chromiumPath: installed ? execPath : null,
      error: installed
        ? null
        : `Chromium not found at ${execPath}. Run: bunx playwright install chromium`,
    };
  } catch (err) {
    return {
      playwrightAvailable: true,
      chromiumInstalled: false,
      chromiumPath: null,
      error:
        err instanceof Error ? err.message : "Failed to check Chromium install",
    };
  }
}
