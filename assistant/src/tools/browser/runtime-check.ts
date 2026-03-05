import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BrowserRuntimeStatus {
  playwrightAvailable: boolean;
  chromiumInstalled: boolean;
  chromiumPath: string | null;
  error: string | null;
}

/**
 * Import playwright, falling back to a runtime-installed copy if the
 * bundled import fails (compiled Bun binaries can't initialize
 * playwright's in-process client/server bridge correctly).
 */
export async function importPlaywright(): Promise<typeof import("playwright")> {
  // Try bundled import (works in dev/source mode)
  try {
    const pw = await import("playwright");
    const mod = pw.chromium
      ? pw
      : (pw.default as typeof pw | undefined)?.chromium
        ? (pw.default as typeof pw)
        : undefined;
    if (mod?.chromium) return mod;
  } catch {
    // Bundled import failed entirely — fall through to runtime install
  }

  // Compiled binary fallback: install playwright to disk and import
  // from an absolute path so the JS runtime resolves it from the
  // filesystem instead of the compiled module cache.
  const externalDir = join(homedir(), ".vellum", "workspace", "external");
  const pwPkg = join(externalDir, "node_modules", "playwright");

  if (!existsSync(join(pwPkg, "package.json"))) {
    mkdirSync(externalDir, { recursive: true });
    if (!existsSync(join(externalDir, "package.json"))) {
      writeFileSync(join(externalDir, "package.json"), '{"private":true}\n');
    }
    const proc = Bun.spawnSync(["bun", "add", "playwright"], {
      cwd: externalDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      const stderr = new TextDecoder().decode(proc.stderr);
      throw new Error(`Failed to install playwright: ${stderr}`);
    }
  }

  // Dynamic import with a runtime-computed path — bun can't statically
  // analyze this, so it resolves from the filesystem at runtime.
  const entryPath = join(pwPkg, "index.mjs");
  const pw: Record<string, unknown> = await import(entryPath);
  const mod = pw.chromium
    ? pw
    : (pw.default as Record<string, unknown> | undefined)?.chromium
      ? (pw.default as Record<string, unknown>)
      : undefined;
  if (!mod?.chromium) {
    throw new Error(
      "Failed to resolve Playwright chromium from runtime-installed copy",
    );
  }
  return mod as unknown as typeof import("playwright");
}

export async function checkBrowserRuntime(): Promise<BrowserRuntimeStatus> {
  // Check if playwright can be imported
  let chromium: { executablePath: () => string };
  try {
    const pw = await importPlaywright();
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
