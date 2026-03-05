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
  /** Test case name (e.g. "hello-world"). Used to create an isolated BASE_DATA_DIR per test. */
  testName?: string;
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

  const baseDataDir = setupTestDataDir(options.testName);

  verifyAppExists(appDisplayName);
  preApproveScreenCapture();
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
      cleanupTestDataDir(baseDataDir);
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

  const baseDataDir = setupTestDataDir(options.testName);

  verifyAppExists(appDisplayName);
  preApproveScreenCapture();
  ensureVellumInPath(appDisplayName);
  await ensureAssistantHatched();
  skipAssistantOnboarding();
  ensureApiKeyInDefaults();

  return {
    teardown: async () => {
      retireAssistant();
      quitApp(appDisplayName);
      cleanupTestDataDir(baseDataDir);
    },
  };
}

// ── Path Helpers ────────────────────────────────────────────────────

/** Resolves the base data directory, respecting the BASE_DATA_DIR env var. */
function getBaseDir(): string {
  return process.env.BASE_DATA_DIR?.trim() || os.homedir();
}

/**
 * Creates an isolated BASE_DATA_DIR for a test and sets it in the environment.
 * Returns the directory path so teardown can clean it up.
 */
function setupTestDataDir(testName?: string): string | undefined {
  if (!testName) return undefined;

  const slug = testName.replace(/[^a-zA-Z0-9_-]/g, "-");
  const dir = path.join(os.tmpdir(), `pw-test-${slug}`);
  mkdirSync(dir, { recursive: true });
  process.env.BASE_DATA_DIR = dir;
  return dir;
}

/**
 * Removes the per-test BASE_DATA_DIR created by setupTestDataDir and
 * restores the environment variable to its previous state.
 */
function cleanupTestDataDir(dir: string | undefined): void {
  if (!dir) return;
  delete process.env.BASE_DATA_DIR;
  try {
    execSync(`rm -rf ${JSON.stringify(dir)}`, { timeout: 10_000 });
  } catch {
    // Best-effort cleanup
  }
}

// ── Shared Helpers ──────────────────────────────────────────────────

/**
 * Pre-approve screen recording so the macOS 15+ "requesting to bypass
 * the system private window picker" dialog never appears during tests.
 *
 * Sets the ScreenCaptureApprovals plist last-alerted timestamp far into
 * the future for the binaries that trigger the prompt (screencapture,
 * bash, zsh). The CI workflow also grants the underlying TCC entitlement
 * via sudo; this helper covers local-development runs where the
 * developer has already approved once but the monthly nag would recur.
 */
function preApproveScreenCapture(): void {
  const approvalsDir = path.join(
    os.homedir(),
    "Library",
    "Group Containers",
    "group.com.apple.replayd",
  );
  mkdirSync(approvalsDir, { recursive: true });
  const approvalsPlist = path.join(approvalsDir, "ScreenCaptureApprovals");
  const targets = ["/usr/sbin/screencapture", "/bin/bash", "/bin/zsh"];

  for (const target of targets) {
    try {
      execSync(
        `defaults write ${JSON.stringify(approvalsPlist)} ${JSON.stringify(target)} ` +
          `-dict kScreenCaptureApprovalLastAlerted -date "4321-01-01 00:00:00 +0000"`,
        { timeout: 5_000 },
      );
    } catch {
      // May fail without Full Disk Access — CI workflow handles this via sudo
    }
  }
}

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
 * Resolves the bundled binaries inside the desktop app and symlinks them
 * into a temporary bin directory prepended to PATH. Symlinks vellum-cli
 * as `vellum`, plus vellum-daemon and vellum-gateway so the CLI can find
 * sibling binaries when hatching. Sets VELLUM_DESKTOP_APP so the CLI
 * uses the bundled-binary code path instead of looking for source files.
 */
function ensureVellumInPath(appDisplayName: string): void {
  const appDir = path.resolve(__dirname, "../../clients/macos/dist");
  const macosDir = path.join(appDir, `${appDisplayName}.app`, "Contents", "MacOS");
  const cliBinary = path.join(macosDir, "vellum-cli");

  if (!existsSync(cliBinary)) {
    throw new Error(`Bundled CLI not found at: ${cliBinary}`);
  }

  // Create a temp bin dir with symlinks for all bundled binaries
  const tmpBin = path.join(__dirname, "../.vellum-bin");
  mkdirSync(tmpBin, { recursive: true });

  const symlinks: Array<[string, string]> = [
    [cliBinary, path.join(tmpBin, "vellum")],
    [path.join(macosDir, "vellum-daemon"), path.join(tmpBin, "vellum-daemon")],
    [path.join(macosDir, "vellum-gateway"), path.join(tmpBin, "vellum-gateway")],
  ];

  for (const [target, link] of symlinks) {
    if (!existsSync(target)) continue;
    try {
      execSync(`ln -sf ${JSON.stringify(target)} ${JSON.stringify(link)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create symlink ${link}: ${message}`);
    }
  }

  // Prepend the temp bin dir to PATH
  if (!process.env.PATH?.includes(tmpBin)) {
    process.env.PATH = `${tmpBin}:${process.env.PATH ?? ""}`;
  }

  // Tell the CLI to use the bundled-binary code path
  process.env.VELLUM_DESKTOP_APP = "1";

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
  const { runtimeUrl, assistantId } = readAssistantFromLockfile(hatchOutput);

  // Poll the daemon directly (port 7821) rather than through the gateway,
  // since the gateway may require auth for proxied health checks.
  const daemonUrl = "http://localhost:7821";

  const maxWaitMs = 60_000;
  const pollIntervalMs = 1_000;
  const startTime = Date.now();
  let lastHealthError = "";

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1_500);
      const response = await fetch(`${daemonUrl}/healthz`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const body = (await response.json()) as { status?: string };
        if (body.status === "healthy") {
          return;
        }
        lastHealthError = `status=${response.status} body=${JSON.stringify(body)}`;
      } else {
        lastHealthError = `status=${response.status}`;
      }
    } catch (err) {
      lastHealthError =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Collect diagnostics
  const diagParts: string[] = [];

  diagParts.push(`Last health check error: ${lastHealthError}`);

  // vellum ps (overview)
  try {
    const ps = execSync("vellum ps 2>&1", {
      encoding: "utf-8",
      timeout: 30_000,
      shell: "/bin/bash",
    });
    diagParts.push(`--- vellum ps ---\n${ps.trim()}`);
  } catch (err: unknown) {
    diagParts.push(
      `--- vellum ps ---\n${(err as { stdout?: string }).stdout || "failed"}`,
    );
  }

  // vellum ps <name> (subprocess details)
  if (assistantId) {
    try {
      const psDetail = execSync(
        `vellum ps ${JSON.stringify(assistantId)} 2>&1`,
        { encoding: "utf-8", timeout: 30_000, shell: "/bin/bash" },
      );
      diagParts.push(
        `--- vellum ps ${assistantId} ---\n${psDetail.trim()}`,
      );
    } catch (err: unknown) {
      diagParts.push(
        `--- vellum ps ${assistantId} ---\n${(err as { stdout?: string }).stdout || "failed"}`,
      );
    }
  }

  diagParts.push(buildDiagnostics(hatchOutput));

  throw new Error(
    `Assistant daemon at ${daemonUrl} did not become healthy within ${maxWaitMs / 1_000}s ` +
      `(gateway: ${runtimeUrl})\n\n${diagParts.join("\n\n")}`,
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
 * Reads the latest assistant's runtimeUrl and assistantId from ~/.vellum.lock.json.
 * Throws if the lockfile is missing or has no assistant entries.
 */
function readAssistantFromLockfile(hatchOutput: string): {
  runtimeUrl: string;
  assistantId: string;
} {
  const diagnostics = buildDiagnostics(hatchOutput);
  const lockfilePath = path.join(getBaseDir(), ".vellum.lock.json");

  if (!existsSync(lockfilePath)) {
    throw new Error(
      `Lockfile not found at ${lockfilePath} after hatching.\n${diagnostics}`,
    );
  }

  const raw = readFileSync(lockfilePath, "utf-8");
  const data = JSON.parse(raw) as {
    assistants?: { runtimeUrl?: string; assistantId?: string }[];
  };
  const assistants = data.assistants;

  if (!Array.isArray(assistants) || assistants.length === 0) {
    throw new Error(
      `No assistant entries in lockfile after hatching.\n${diagnostics}`,
    );
  }

  const entry = assistants[0];
  if (!entry.runtimeUrl) {
    throw new Error(
      `Assistant entry missing runtimeUrl in lockfile.\n${diagnostics}`,
    );
  }

  return {
    runtimeUrl: entry.runtimeUrl,
    assistantId: entry.assistantId || "",
  };
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
      const tail = lines.slice(-200).join("\n");
      parts.push(`--- hatch.log (last 200 lines) ---\n${tail}`);
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

/**
 * Writes the ANTHROPIC_API_KEY from the environment into the app's
 * UserDefaults so the macOS app sees a valid key and skips the auth
 * setup screen.
 */
function ensureApiKeyInDefaults(): void {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  const domain = "com.vellum.vellum-assistant";
  try {
    execSync(
      `defaults write ${domain} vellum_provider_anthropic ${JSON.stringify(apiKey)}`,
      { timeout: 5_000 },
    );
  } catch {
    // Best-effort — tests may still work if auth is handled differently
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
    const firstLine = lines[0]?.trim();
    const columns = firstLine?.split(/\s{2,}/);
    // A valid assistant row has multiple columns (NAME, STATUS, …).
    // Messages like "No running assistants" are a single column — skip them.
    const assistantName = columns && columns.length >= 2 ? columns[0] : undefined;
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
