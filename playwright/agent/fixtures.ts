/**
 * Test fixture management for the agent runner.
 *
 * Handles setup and teardown of test fixtures. Each fixture performs
 * any required pre-test setup (e.g., verifying app exists, clearing state)
 * and provides a teardown function for cleanup.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import os from "os";
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
  await ensureAssistantHatched();
  skipAssistantOnboarding();

  return {
    teardown: async () => {
      retireAssistant();
      quitApp(appDisplayName);
    },
  };
}

// ── Path Helpers ────────────────────────────────────────────────────

/** Resolves the base data directory, respecting the BASE_DATA_DIR env var. */
function getBaseDir(): string {
  return process.env.BASE_DATA_DIR?.trim() || os.homedir();
}

// ── Shared Helpers ──────────────────────────────────────────────────

function verifyAppExists(appDisplayName: string): void {
  const appDir = path.resolve(__dirname, "../../clients/macos/dist");
  const appPath = path.join(appDir, `${appDisplayName}.app`);
  if (!existsSync(appPath)) {
    throw new Error(`Built macOS app not found at: ${appPath}`);
  }

  // Restore execute permissions on all binaries inside the app bundle.
  // CI artifact extraction (zip/unzip) strips the +x bit from Mach-O
  // binaries, which prevents the app and its helpers from launching.
  const macosDir = path.join(appPath, "Contents", "MacOS");
  if (existsSync(macosDir)) {
    execSync(`chmod +x ${JSON.stringify(macosDir)}/*`);
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
 * Ensures an assistant is hatched, the lockfile is populated, and the
 * assistant is healthy before returning.
 *
 * Checks the lockfile for an existing assistant. If none is found,
 * runs `vellum hatch` to create one. Then polls `/healthz` until
 * the assistant reports healthy.
 */
async function ensureAssistantHatched(): Promise<void> {
  let hatchOutput = "";
  if (!hasAssistantInLockfile()) {
    try {
      hatchOutput = execSync("vellum hatch 2>&1", {
        encoding: "utf-8",
        timeout: 300_000,
        shell: "/bin/bash",
      });
    } catch (err: unknown) {
      const output =
        (err as { stdout?: string }).stdout ||
        (err as { stderr?: string }).stderr ||
        "";
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to hatch assistant: ${message}${output ? `\n--- vellum hatch output ---\n${output}` : ""}`,
      );
    }
  }

  logVellumPs();

  // Verify the lockfile was updated with an assistant entry
  const runtimeUrl = readRuntimeUrlFromLockfile(hatchOutput);

  // Poll health endpoint until the assistant is ready
  const maxWaitMs = 60_000;
  const pollIntervalMs = 1_000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1_500);
      const response = await fetch(`${runtimeUrl}/healthz`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const body = (await response.json()) as { status?: string };
        if (body.status === "healthy") {
          return;
        }
      }
    } catch {
      // Not ready yet — keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Assistant at ${runtimeUrl} did not become healthy within ${maxWaitMs / 1_000}s`,
  );
}

/** Returns true if the lockfile exists and contains at least one assistant. */
function hasAssistantInLockfile(): boolean {
  const lockfilePath = path.join(getBaseDir(), ".vellum.lock.json");
  if (!existsSync(lockfilePath)) return false;
  try {
    const raw = readFileSync(lockfilePath, "utf-8");
    const data = JSON.parse(raw) as { assistants?: unknown[] };
    return Array.isArray(data.assistants) && data.assistants.length > 0;
  } catch {
    return false;
  }
}

/**
 * Reads the latest assistant's runtimeUrl from ~/.vellum.lock.json.
 * Throws if the lockfile is missing or has no assistant entries.
 */
function readRuntimeUrlFromLockfile(hatchOutput: string): string {
  const diagnostics = buildDiagnostics(hatchOutput);
  const lockfilePath = path.join(getBaseDir(), ".vellum.lock.json");

  if (!existsSync(lockfilePath)) {
    throw new Error(
      `Lockfile not found at ${lockfilePath} after hatching.\n${diagnostics}`,
    );
  }

  const raw = readFileSync(lockfilePath, "utf-8");
  const data = JSON.parse(raw) as { assistants?: { runtimeUrl?: string }[] };
  const assistants = data.assistants;

  if (!Array.isArray(assistants) || assistants.length === 0) {
    throw new Error(
      `No assistant entries in lockfile after hatching.\n${diagnostics}`,
    );
  }

  const runtimeUrl = assistants[0].runtimeUrl;
  if (!runtimeUrl) {
    throw new Error(
      `Assistant entry missing runtimeUrl in lockfile.\n${diagnostics}`,
    );
  }

  return runtimeUrl;
}

/** Collects hatch CLI output and hatch.log into a single diagnostic string. */
function buildDiagnostics(hatchOutput: string): string {
  const parts: string[] = [];

  if (hatchOutput.trim()) {
    parts.push(`--- vellum hatch output ---\n${hatchOutput.trim()}`);
  }

  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const logPath = path.join(configHome, "vellum", "logs", "hatch.log");
  if (existsSync(logPath)) {
    try {
      const contents = readFileSync(logPath, "utf-8");
      const lines = contents.split("\n");
      const tail = lines.slice(-50).join("\n");
      parts.push(`--- hatch.log (last 50 lines) ---\n${tail}`);
    } catch {
      parts.push(`Failed to read hatch.log at ${logPath}`);
    }
  } else {
    parts.push(`hatch.log not found at ${logPath}`);
  }

  return parts.join("\n\n");
}

/**
 * Deletes BOOTSTRAP.md from the assistant workspace so the assistant
 * skips its first-run acclimation flow (name, personality, etc.).
 */
function skipAssistantOnboarding(): void {
  const bootstrapPath = path.join(getBaseDir(), ".vellum", "workspace", "BOOTSTRAP.md");
  if (existsSync(bootstrapPath)) {
    unlinkSync(bootstrapPath);
  }
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
