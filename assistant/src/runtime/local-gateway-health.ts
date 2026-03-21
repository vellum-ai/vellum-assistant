import { getGatewayInternalBaseUrl } from "../config/env.js";
import { getIsContainerized } from "../config/env-registry.js";
import { sleep } from "../util/retry.js";

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_RECOVERY_POLL_TIMEOUT_MS = 30_000;
const DEFAULT_RECOVERY_POLL_INTERVAL_MS = 250;
const DEFAULT_WAKE_TIMEOUT_MS = 90_000;

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

function resolveLocalDeployment(): boolean {
  if (getIsContainerized()) {
    return false;
  }

  const cloud = process.env.VELLUM_CLOUD;
  if (cloud) {
    return cloud === "local";
  }

  return true;
}

function resolveLocalAssistantName(): string | undefined {
  return process.env.VELLUM_ASSISTANT_NAME;
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

  return new Promise((resolve, reject) => {
    const proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"]
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
