import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  appendFileSync,
  readFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

import {
  allocateLocalResources,
  findAssistantByName,
  saveAssistantEntry,
  setActiveAssistant,
} from "./assistant-config.js";
import type { AssistantEntry } from "./assistant-config.js";
import type { Species } from "./constants.js";
import { buildHatchConfigValues, writeInitialConfig } from "./config-utils.js";
import {
  generateLocalSigningKey,
  startLocalDaemon,
  startGateway,
  stopLocalProcesses,
} from "./local.js";

import { generateInstanceName } from "./random-name.js";
import { leaseGuardianToken } from "./guardian-token.js";
import { archiveLogFile, resetLogFile } from "./xdg-log.js";
import {
  consoleLifecycleReporter,
  type LifecycleReporter,
} from "./lifecycle-reporter.js";
import {
  configureHatchProviderApiKey,
  formatProviderName,
  resolveHatchProvider,
} from "./provider-secrets.js";
import { logHatchNextSteps } from "./hatch-next-steps.js";
import { checkProviderApiKey } from "./api-key-check.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";

/**
 * Attempts to place a symlink at the given path pointing to cliBinary.
 * Returns true if the symlink was created (or already correct), false on failure.
 */
function trySymlink(cliBinary: string, symlinkPath: string): boolean {
  try {
    // Use lstatSync (not existsSync) to detect dangling symlinks —
    // existsSync follows symlinks and returns false for broken links.
    try {
      const stats = lstatSync(symlinkPath);
      if (!stats.isSymbolicLink()) {
        // Real file — don't overwrite (developer's local install)
        return false;
      }
      // Already a symlink — skip if it already points to our binary
      const dest = readlinkSync(symlinkPath);
      if (dest === cliBinary) return true;
      // Stale or dangling symlink — remove before creating new one
      unlinkSync(symlinkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
      // Path doesn't exist — proceed to create symlink
    }

    const dir = join(symlinkPath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    symlinkSync(cliBinary, symlinkPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures ~/.local/bin is present in the user's shell profile so that
 * symlinks placed there are on PATH in new terminal sessions.
 */
function ensureLocalBinInShellProfile(localBinDir: string): void {
  const shell = process.env.SHELL ?? "";
  const home = homedir();
  // Determine the appropriate shell profile to modify
  const profilePath = shell.endsWith("/zsh")
    ? join(home, ".zshrc")
    : shell.endsWith("/bash")
      ? join(home, ".bash_profile")
      : null;
  if (!profilePath) return;

  try {
    const contents = existsSync(profilePath)
      ? readFileSync(profilePath, "utf-8")
      : "";
    // Check if ~/.local/bin is already referenced in PATH exports
    if (contents.includes(localBinDir)) return;
    const line = `\nexport PATH="${localBinDir}:\$PATH"\n`;
    appendFileSync(profilePath, line);
    console.log(`   Added ${localBinDir} to ${profilePath}`);
  } catch {
    // Not critical — user can add it manually
  }
}

function installCLISymlink(): void {
  const cliBinary = process.execPath;
  if (!cliBinary || !existsSync(cliBinary)) return;

  // Preferred location — works on most Macs where /usr/local/bin exists
  const preferredPath = "/usr/local/bin/vellum";
  if (trySymlink(cliBinary, preferredPath)) {
    console.log(`   Symlinked ${preferredPath} → ${cliBinary}`);
    return;
  }

  // Fallback — use ~/.local/bin which is user-writable and doesn't need root.
  // On some Macs /usr/local doesn't exist and creating it requires admin privileges.
  const localBinDir = join(homedir(), ".local", "bin");
  const fallbackPath = join(localBinDir, "vellum");
  if (trySymlink(cliBinary, fallbackPath)) {
    console.log(`   Symlinked ${fallbackPath} → ${cliBinary}`);
    ensureLocalBinInShellProfile(localBinDir);
    return;
  }

  console.log(
    `   ⚠ Could not create symlink for vellum CLI (tried ${preferredPath} and ${fallbackPath})`,
  );
}

export interface HatchLocalOptions {
  setupProviderCredentials?: boolean;
  /**
   * Sink for progress and log output. Defaults to the console reporter so CLI
   * callers keep their existing terminal output; in-process callers can inject
   * their own reporter to consume progress without writing to stdout.
   */
  reporter?: LifecycleReporter;
}

export interface HatchLocalResult {
  assistantId: string;
  runtimeUrl: string;
  localUrl: string;
  species: Species;
  /**
   * Guardian access token leased during hatch, when the lease succeeded. The
   * full token pair is persisted to disk regardless; this is surfaced so an
   * in-process caller can prime a connection without re-reading the file.
   */
  guardianAccessToken?: string;
}

export async function hatchLocal(
  species: Species,
  name: string | null,
  watch: boolean = false,
  keepAlive: boolean = false,
  configValues: Record<string, string> = {},
  flagEnvVars: Record<string, string> = {},
  options: HatchLocalOptions = {},
): Promise<HatchLocalResult> {
  const reporter = options.reporter ?? consoleLifecycleReporter;
  const provider =
    options.setupProviderCredentials === false
      ? undefined
      : resolveHatchProvider(configValues);
  const instanceName = generateInstanceName(
    species,
    name ?? process.env.VELLUM_ASSISTANT_NAME,
  );

  reporter.progress(1, 6, "Allocating resources...");

  const existing = findAssistantByName(instanceName);
  if (existing && (!existing.cloud || existing.cloud === "local")) {
    throw new Error(
      `An assistant named "${instanceName}" is already hatched.\n` +
        `Run \`vellum wake\` to restart it, or \`vellum retire ${instanceName}\` to remove it first.`,
    );
  }

  const resources = await allocateLocalResources(instanceName);

  const logsDir = join(
    resources.instanceDir,
    ".vellum",
    "workspace",
    "data",
    "logs",
  );
  archiveLogFile("hatch.log", logsDir);
  resetLogFile("hatch.log");

  reporter.log(`🥚 Hatching local assistant: ${instanceName}`);
  reporter.log(`   Species: ${species}`);
  reporter.log("");

  const apiKeyCheck = checkProviderApiKey();
  if (!apiKeyCheck.hasKey) {
    reporter.warn(
      "Warning: No LLM provider API key is configured. The assistant will fail when you try to send a message.",
    );
    reporter.warn("  To fix, export your key before running vellum hatch:");
    reporter.warn("  export ANTHROPIC_API_KEY=<your-key>");
    reporter.warn("");
  }

  if (!process.env.APP_VERSION) {
    process.env.APP_VERSION = cliPkg.version;
  }

  reporter.progress(2, 6, "Writing configuration...");
  const hatchConfigValues = buildHatchConfigValues(configValues, provider);
  const defaultWorkspaceConfigPath = writeInitialConfig(hatchConfigValues);

  reporter.progress(3, 6, "Starting assistant...");
  const signingKey = generateLocalSigningKey();
  const bootstrapSecret = generateLocalSigningKey();
  await startLocalDaemon(watch, resources, {
    defaultWorkspaceConfigPath,
    signingKey,
  });

  reporter.progress(4, 6, "Starting gateway...");
  let runtimeUrl = `http://127.0.0.1:${resources.gatewayPort}`;
  try {
    runtimeUrl = await startGateway(watch, resources, {
      signingKey,
      bootstrapSecret,
      envOverrides: flagEnvVars,
    });
  } catch (error) {
    // Gateway failed — stop the daemon we just started so we don't leave
    // orphaned processes with no lock file entry.
    reporter.error(
      `\n❌ Gateway startup failed — stopping assistant to avoid orphaned processes.`,
    );
    await stopLocalProcesses(resources);
    throw error;
  }

  // Lease a guardian token so the desktop app can import it on first launch
  // instead of hitting /v1/guardian/init itself. Use loopback to satisfy
  // the daemon's local-only check — the mDNS runtimeUrl resolves to a LAN
  // IP which the daemon rejects as non-loopback.
  reporter.progress(5, 6, "Securing connection...");
  const loopbackUrl = `http://127.0.0.1:${resources.gatewayPort}`;
  const maxLeaseAttempts = 3;
  let guardianAccessToken: string | undefined;
  for (let attempt = 1; attempt <= maxLeaseAttempts; attempt++) {
    try {
      const tokenData = await leaseGuardianToken(
        loopbackUrl,
        instanceName,
        bootstrapSecret,
      );
      guardianAccessToken = tokenData.accessToken;
      break;
    } catch (err) {
      if (attempt < maxLeaseAttempts) {
        const delayMs = 2000 * 2 ** (attempt - 1);
        reporter.error(
          `⚠️  Guardian token lease attempt ${attempt}/${maxLeaseAttempts} failed — retrying in ${delayMs / 1000}s: ${err}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        reporter.error(
          `⚠️  Guardian token lease failed after ${maxLeaseAttempts} attempts: ${err}\n` +
            `   The assistant is running but guardian-token.json was not written.\n` +
            `   If the desktop app loses its stored credentials, re-hatch to recover.`,
        );
      }
    }
  }

  // Auto-start ngrok if webhook integrations (e.g. Telegram, Twilio) are configured.
  const localEntry: AssistantEntry = {
    assistantId: instanceName,
    runtimeUrl,
    localUrl: `http://127.0.0.1:${resources.gatewayPort}`,
    cloud: "local",
    species,
    hatchedAt: new Date().toISOString(),
    resources: { ...resources, signingKey },
    guardianBootstrapSecret: bootstrapSecret,
  };

  reporter.progress(6, 6, "Saving configuration...");
  saveAssistantEntry(localEntry);
  setActiveAssistant(instanceName);

  if (process.env.VELLUM_DESKTOP_APP) {
    installCLISymlink();
  }

  if (provider !== undefined && provider !== null && !guardianAccessToken) {
    reporter.error(
      `⚠️  Provider credential setup skipped because the guardian token was not leased.\n` +
        `   The assistant is still hatched. Run \`vellum setup --provider ${provider}\` after fixing the connection.`,
    );
  } else if (provider !== undefined) {
    reporter.log("");
    reporter.log(
      provider === null
        ? "Checking provider credentials..."
        : `Checking ${formatProviderName(provider)} credentials...`,
    );
    await configureHatchProviderApiKey({
      gatewayUrl: loopbackUrl,
      provider,
      bearerToken: guardianAccessToken,
      env: process.env,
    });
  }

  reporter.log("");
  reporter.log(`✅ Local assistant hatched!`);
  reporter.log("");
  reporter.log("Instance details:");
  reporter.log(`  Name: ${instanceName}`);
  reporter.log(`  Runtime: ${runtimeUrl}`);
  reporter.log("");
  logHatchNextSteps((message) => reporter.log(message), instanceName);

  const result: HatchLocalResult = {
    assistantId: instanceName,
    runtimeUrl,
    localUrl: `http://127.0.0.1:${resources.gatewayPort}`,
    species,
    guardianAccessToken,
  };

  if (keepAlive) {
    const healthUrl = `http://127.0.0.1:${resources.gatewayPort}/healthz`;
    const healthTarget = "Gateway";
    const POLL_INTERVAL_MS = 5000;
    const MAX_FAILURES = 3;
    let consecutiveFailures = 0;

    const shutdown = async (): Promise<void> => {
      reporter.log("\nShutting down local processes...");
      await stopLocalProcesses(resources);
      process.exit(0);
    };

    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());

    // Poll the health endpoint until it stops responding.
    while (true) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const res = await loopbackSafeFetch(healthUrl, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
        }
      } catch {
        consecutiveFailures++;
      }
      if (consecutiveFailures >= MAX_FAILURES) {
        reporter.log(
          `\n⚠️  ${healthTarget} stopped responding — shutting down.`,
        );
        await stopLocalProcesses(resources);
        process.exit(1);
      }
    }
  }

  return result;
}
