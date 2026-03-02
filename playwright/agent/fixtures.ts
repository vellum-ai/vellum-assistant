/**
 * Test fixture management for the agent runner.
 *
 * Handles setup and teardown of test fixtures. Each fixture performs
 * any required pre-test setup (e.g., verifying app exists, clearing state)
 * and provides a teardown function for cleanup.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";

// ── Types ───────────────────────────────────────────────────────────

export interface FixtureContext {
  /** Cleanup function to tear down the fixture */
  teardown: () => Promise<void>;
}

export interface FixtureOptions {
  /** Playwright parallel worker index (0-based). Used to isolate app instances, defaults domains, etc. */
  workerIndex?: number;
}

// ── Fixture Registry ────────────────────────────────────────────────


type FixtureFactory = (options: FixtureOptions) => Promise<FixtureContext>;

const FIXTURE_REGISTRY: Record<string, FixtureFactory> = {
  "desktop-app": createDesktopAppFixture,
  "desktop-app-hatched": createDesktopAppHatchedFixture,
};

// ── Fixture Implementations ─────────────────────────────────────────

/**
 * Returns a worker-specific UserDefaults domain suffix.
 * Worker 0 uses the default domain; workers 1+ append "-wN".
 *
 * NOTE: This only isolates the `defaults` CLI calls made during fixture
 * setup/teardown. The app itself still reads its compiled bundle identifier.
 * True per-worker isolation requires either:
 *   (a) building N app copies with distinct bundle IDs, or
 *   (b) passing the domain via a launch argument the app respects.
 * See the PR description for the full analysis.
 */
function defaultsDomain(workerIndex: number): string {
  const base = "com.vellum.vellum-assistant";
  return workerIndex === 0 ? base : `${base}-w${workerIndex}`;
}

async function createDesktopAppFixture(options: FixtureOptions): Promise<FixtureContext> {
  const workerIndex = options.workerIndex ?? 0;
  const appDisplayName = process.env.APP_DISPLAY_NAME ?? "Vellum";

  verifyAppExists(appDisplayName);
  logVellumPs();

  // Clear any previous onboarding state
  const domain = defaultsDomain(workerIndex);
  try {
    execSync(`defaults delete ${domain}`, {
      encoding: "utf-8",
      timeout: 5_000,
    });
  } catch {
    // Domain may not exist yet on a fresh runner — that's fine
  }

  return {
    teardown: async () => {
      retireAssistant();
      quitApp(appDisplayName);
    },
  };
}

/**
 * Fixture for tests that assume an assistant is already hatched.
 *
 * Skips clearing onboarding state so the desktop app opens straight
 * to the already-hatched assistant instead of showing the setup flow.
 */
async function createDesktopAppHatchedFixture(options: FixtureOptions): Promise<FixtureContext> {
  const _workerIndex = options.workerIndex ?? 0;
  const appDisplayName = process.env.APP_DISPLAY_NAME ?? "Vellum";

  verifyAppExists(appDisplayName);
  ensureVellumInPath(appDisplayName);
  ensureAssistantHatched();

  return {
    teardown: async () => {
      retireAssistant();
      quitApp(appDisplayName);
    },
  };
}

// ── Shared Helpers ──────────────────────────────────────────────────

function verifyAppExists(appDisplayName: string): void {
  const appDir = path.resolve(__dirname, "../../clients/macos/dist");
  const appPath = path.join(appDir, `${appDisplayName}.app`);
  if (!existsSync(appPath)) {
    throw new Error(`Built macOS app not found at: ${appPath}`);
  }
}

function logVellumPs(): void {
  try {
    const psOutput = execSync("vellum ps", {
      encoding: "utf-8",
      timeout: 30_000,
      shell: "/bin/bash",
    });
    const logsDir = path.resolve(__dirname, "../test-results/agent-logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(path.join(logsDir, "vellum-ps.log"), psOutput);
  } catch (err) {
    const logsDir = path.resolve(__dirname, "../test-results/agent-logs");
    mkdirSync(logsDir, { recursive: true });
    const message = err instanceof Error ? err.message : String(err);
    writeFileSync(path.join(logsDir, "vellum-ps.log"), `vellum ps failed: ${message}\n`);
  }
}

/**
 * Resolves the path to the bundled `vellum-cli` binary inside the
 * desktop app and creates a `vellum` symlink in a temporary bin
 * directory that is prepended to PATH. This ensures all subsequent
 * `vellum` commands use the CLI that ships with the app under test.
 */
function ensureVellumInPath(appDisplayName: string): void {
  const appDir = path.resolve(__dirname, "../../clients/macos/dist");
  const cliBinary = path.join(appDir, `${appDisplayName}.app`, "Contents", "MacOS", "vellum-cli");

  if (!existsSync(cliBinary)) {
    throw new Error(`Bundled CLI not found at: ${cliBinary}`);
  }

  // Ensure the binary is executable (may lose +x when extracted from CI artifacts)
  execSync(`chmod +x ${JSON.stringify(cliBinary)}`);

  // Create a temp bin dir with a `vellum` symlink pointing to the bundled CLI
  const tmpBin = path.join(__dirname, "../.vellum-bin");
  mkdirSync(tmpBin, { recursive: true });
  const symlinkPath = path.join(tmpBin, "vellum");

  try {
    // Remove stale symlink if it exists
    if (existsSync(symlinkPath)) {
      execSync(`rm -f ${JSON.stringify(symlinkPath)}`);
    }
    execSync(`ln -s ${JSON.stringify(cliBinary)} ${JSON.stringify(symlinkPath)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create vellum symlink: ${message}`);
  }

  // Prepend the temp bin dir to PATH
  if (!process.env.PATH?.includes(tmpBin)) {
    process.env.PATH = `${tmpBin}:${process.env.PATH ?? ""}`;
  }

  // Verify it works
  try {
    execSync("vellum --version", {
      encoding: "utf-8",
      timeout: 10_000,
      shell: "/bin/bash",
      env: process.env,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `vellum CLI not working after symlinking bundled binary from ${cliBinary}: ${message}`,
    );
  }
}

/**
 * Ensures an assistant is hatched.
 *
 * Checks `vellum ps` for an existing assistant. If none is found,
 * runs `vellum hatch` to create one.
 */
function ensureAssistantHatched(): void {
  let psOutput: string;
  try {
    psOutput = execSync("vellum ps", {
      encoding: "utf-8",
      timeout: 30_000,
      shell: "/bin/bash",
    });
  } catch {
    // vellum ps failed — try hatching
    psOutput = "";
  }

  const lines = psOutput
    .split("\n")
    .filter((l) => l.trim() && !l.includes("NAME") && !l.startsWith("  -"));

  if (lines.length > 0) {
    logVellumPs();
    return;
  }

  // No assistant found — hatch one
  try {
    execSync("vellum hatch", {
      stdio: "inherit",
      timeout: 300_000,
      shell: "/bin/bash",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to hatch assistant: ${message}`);
  }

  logVellumPs();
}

function retireAssistant(): void {
  try {
    const psOutput = execSync("vellum ps", {
      encoding: "utf-8",
      timeout: 30_000,
      shell: "/bin/bash",
    });
    const lines = psOutput
      .split("\n")
      .filter((l) => l.trim() && !l.includes("NAME") && !l.startsWith("  -"));
    const assistantName = lines[0]?.trim().split(/\s{2,}/)[0];
    if (assistantName) {
      execSync(`vellum retire ${assistantName}`, {
        timeout: 30_000,
        shell: "/bin/bash",
      });
    }
  } catch {
    // vellum CLI may not be installed or no assistant to retire
  }
}

function quitApp(appDisplayName: string): void {
  try {
    execSync(
      `osascript -e 'tell application "${appDisplayName}" to quit'`,
      { timeout: 5_000 },
    );
  } catch {
    // App may already be closed
  }
}

// ── Public API ──────────────────────────────────────────────────────

export async function setupFixture(fixtureName: string, options: FixtureOptions = {}): Promise<FixtureContext> {
  const factory = FIXTURE_REGISTRY[fixtureName];
  if (!factory) {
    throw new Error(
      `Unknown fixture: "${fixtureName}". Available fixtures: ${Object.keys(FIXTURE_REGISTRY).join(", ")}`,
    );
  }
  return factory(options);
}
