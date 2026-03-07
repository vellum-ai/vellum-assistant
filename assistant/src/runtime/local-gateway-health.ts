import { getGatewayInternalBaseUrl } from "../config/env.js";
import { getBaseDataDir, getIsContainerized } from "../config/env-registry.js";
import { readLockfile } from "../util/platform.js";
import { sleep } from "../util/retry.js";

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_RECOVERY_POLL_TIMEOUT_MS = 30_000;
const DEFAULT_RECOVERY_POLL_INTERVAL_MS = 250;
const DEFAULT_WAKE_TIMEOUT_MS = 90_000;

interface LockfileAssistantEntry {
  assistantId?: string;
  cloud?: string;
  hatchedAt?: string | number | Date;
}

export interface WakeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LocalGatewayHealthResult {
  target: string;
  healthy: boolean;
  localDeployment: boolean;
  error?: string;
}

export interface EnsureLocalGatewayReadyResult extends LocalGatewayHealthResult {
  recovered: boolean;
  recoveryAttempted: boolean;
  recoverySkipped: boolean;
}

export interface ProbeLocalGatewayHealthOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface EnsureLocalGatewayReadyOptions extends ProbeLocalGatewayHealthOptions {
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  wakeTimeoutMs?: number;
  runWakeCommand?: () => Promise<WakeCommandResult>;
  sleepImpl?: (ms: number) => Promise<void>;
}

function getLatestAssistantEntry(): LockfileAssistantEntry | null {
  try {
    const lockData = readLockfile();
    const assistants = lockData?.assistants;
    if (!Array.isArray(assistants) || assistants.length === 0) {
      return null;
    }

    const sorted = [...assistants].sort((a, b) => {
      const dateA = new Date(
        (a as LockfileAssistantEntry).hatchedAt || 0,
      ).getTime();
      const dateB = new Date(
        (b as LockfileAssistantEntry).hatchedAt || 0,
      ).getTime();
      return dateB - dateA;
    });

    return (sorted[0] as LockfileAssistantEntry) ?? null;
  } catch {
    return null;
  }
}

function resolveLocalDeployment(): boolean {
  if (getIsContainerized()) {
    return false;
  }

  const latestAssistant = getLatestAssistantEntry();
  if (typeof latestAssistant?.cloud === "string") {
    return latestAssistant.cloud === "local";
  }

  return true;
}

/**
 * Derive instance name from BASE_DATA_DIR which follows the multi-instance
 * path pattern (~/.local/share/vellum/assistants/<name>/).
 */
function resolveInstanceNameFromBaseDataDir(): string | undefined {
  const base = getBaseDataDir();
  if (!base || typeof base !== "string") return undefined;

  const normalized = base.replace(/\\/g, "/").replace(/\/+$/, "");
  const match = normalized.match(/\/assistants\/([^/]+)$/);
  if (match) return match[1];
  return undefined;
}

function resolveLocalAssistantName(): string | undefined {
  const fromPath = resolveInstanceNameFromBaseDataDir();
  if (fromPath) return fromPath;

  const latestAssistant = getLatestAssistantEntry();
  if (
    latestAssistant &&
    typeof latestAssistant.assistantId === "string" &&
    latestAssistant.assistantId.trim().length > 0
  ) {
    return latestAssistant.assistantId.trim();
  }

  return undefined;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runDefaultWakeCommand(
  timeoutMs: number,
): Promise<WakeCommandResult> {
  const assistantName = resolveLocalAssistantName();
  const command = assistantName
    ? ["vellum", "wake", assistantName]
    : ["vellum", "wake"];

  // Only when the assistant name came from the instance path (e.g.
  // ~/.local/share/vellum/assistants/<name>/), unset BASE_DATA_DIR so the
  // spawned CLI reads the global lockfile. When the name came from the
  // lockfile, keep BASE_DATA_DIR — vellum wake resolves names through the
  // lockfile rooted at BASE_DATA_DIR, so clearing it would read the wrong
  // lockfile (e.g. $HOME) and fail or wake the wrong assistant.
  const fromInstancePath = resolveInstanceNameFromBaseDataDir();
  const env =
    fromInstancePath && getBaseDataDir()
      ? { ...process.env, BASE_DATA_DIR: undefined }
      : process.env;

  return new Promise((resolve, reject) => {
    const proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...env,
        PATH: [env.PATH, "/opt/homebrew/bin", "/usr/local/bin"]
          .filter(Boolean)
          .join(":"),
      },
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(
        new Error(`Process timed out after ${timeoutMs}ms: ${command[0]}`),
      );
    }, timeoutMs);
    proc.exited.then(async (exitCode) => {
      clearTimeout(timer);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export async function probeLocalGatewayHealth(
  options: ProbeLocalGatewayHealthOptions = {},
): Promise<LocalGatewayHealthResult> {
  const target = getGatewayInternalBaseUrl();
  const localDeployment = resolveLocalDeployment();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  try {
    const response = await fetchImpl(`${target}/healthz`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        target,
        healthy: false,
        localDeployment,
        error: `Gateway health check returned HTTP ${response.status}`,
      };
    }

    return {
      target,
      healthy: true,
      localDeployment,
    };
  } catch (err) {
    return {
      target,
      healthy: false,
      localDeployment,
      error: formatError(err),
    };
  }
}

export async function ensureLocalGatewayReady(
  options: EnsureLocalGatewayReadyOptions = {},
): Promise<EnsureLocalGatewayReadyResult> {
  const initialProbe = await probeLocalGatewayHealth(options);
  if (initialProbe.healthy) {
    return {
      ...initialProbe,
      recovered: false,
      recoveryAttempted: false,
      recoverySkipped: false,
    };
  }

  if (!initialProbe.localDeployment) {
    return {
      ...initialProbe,
      recovered: false,
      recoveryAttempted: false,
      recoverySkipped: true,
      error:
        initialProbe.error ??
        "Skipped gateway recovery because this assistant is not locally managed",
    };
  }

  const runWakeCommand =
    options.runWakeCommand ??
    (() =>
      runDefaultWakeCommand(options.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS));
  const sleepImpl = options.sleepImpl ?? sleep;
  const pollTimeoutMs =
    options.pollTimeoutMs ?? DEFAULT_RECOVERY_POLL_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_RECOVERY_POLL_INTERVAL_MS;

  let wakeError: string | undefined;
  try {
    const wakeResult = await runWakeCommand();
    if (wakeResult.exitCode !== 0) {
      const detail = wakeResult.stderr.trim() || wakeResult.stdout.trim();
      wakeError = detail
        ? `vellum wake exited with code ${wakeResult.exitCode}: ${detail}`
        : `vellum wake exited with code ${wakeResult.exitCode}`;
    }
  } catch (err) {
    wakeError = `Failed to run vellum wake: ${formatError(err)}`;
  }

  const deadline = Date.now() + pollTimeoutMs;
  let probe = await probeLocalGatewayHealth(options);
  while (!probe.healthy && Date.now() < deadline) {
    await sleepImpl(pollIntervalMs);
    probe = await probeLocalGatewayHealth(options);
  }

  if (probe.healthy) {
    return {
      ...probe,
      recovered: true,
      recoveryAttempted: true,
      recoverySkipped: false,
    };
  }

  const combinedError = [wakeError, probe.error].filter(Boolean).join("; ");
  return {
    ...probe,
    recovered: false,
    recoveryAttempted: true,
    recoverySkipped: false,
    error: combinedError || undefined,
  };
}
