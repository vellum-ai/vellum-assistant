import { spawn } from "node:child_process";

import type { CliInvocation } from "./util";

// Fast loopback HTTP calls; well under the lifecycle-op timeouts.
const DEVICES_TIMEOUT_MS = 30_000;

/**
 * Mirrors one row of the gateway's `GET /v1/devices` response. The gateway
 * stores only the HASHED device id, so `hashedDeviceId` is both the display
 * identifier and the revocation key.
 */
export interface DeviceRecord {
  hashedDeviceId: string;
  platform: string;
  issuedAt: number | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  /** Raw User-Agent observed when this device paired, or null. */
  pairingUserAgent?: string | null;
  /** Name the device reported for itself when pairing, or null. */
  clientReportedName?: string | null;
  /** True when this row is the hosting machine's own guardian credential. */
  isCurrentHost?: boolean;
}

export type DevicesListResult =
  | { ok: true; devices: DeviceRecord[] }
  | { ok: false; error: string };

export type DevicesRevokeResult =
  { ok: true } | { ok: false; error: string };

type CliRunResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

// The CLI prints an identity preamble before acting, so a failure transcript
// is multi-line; surface only the final "Error:" line when one exists.
function extractCliError(stderr: string, stdout: string): string {
  const errorLines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Error:"));
  const last = errorLines[errorLines.length - 1];
  if (last) {
    return last.slice("Error:".length).trim();
  }
  return (stderr || stdout).trim();
}

function runDevicesCli(
  invocation: CliInvocation,
  args: string[],
): Promise<CliRunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      invocation.command,
      [...invocation.baseArgs, ...args],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: CliRunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        error: `Devices command timed out after ${DEVICES_TIMEOUT_MS / 1000} seconds`,
      });
    }, DEVICES_TIMEOUT_MS);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true, stdout });
      } else {
        finish({ ok: false, error: extractCliError(stderr, stdout) });
      }
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        error: `Failed to spawn CLI: ${err.message}`,
      });
    });
  });
}

function toTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseDeviceRecords(stdout: string): DeviceRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const devices = (parsed as { devices?: unknown }).devices;
  if (!Array.isArray(devices)) {
    return null;
  }

  const records: DeviceRecord[] = [];
  for (const entry of devices) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const {
      hashedDeviceId,
      platform,
      issuedAt,
      expiresAt,
      lastUsedAt,
      pairingUserAgent,
      clientReportedName,
      isCurrentHost,
    } = entry as Record<string, unknown>;
    if (typeof hashedDeviceId !== "string" || typeof platform !== "string") {
      return null;
    }
    records.push({
      hashedDeviceId,
      platform,
      issuedAt: toTimestamp(issuedAt),
      expiresAt: toTimestamp(expiresAt),
      lastUsedAt: toTimestamp(lastUsedAt),
      pairingUserAgent: toText(pairingUserAgent),
      clientReportedName: toText(clientReportedName),
      // Tolerant passthrough: only a literal `true` survives.
      ...(isCurrentHost === true ? { isCurrentHost: true } : {}),
    });
  }
  return records;
}

export async function runDevicesList(
  invocation: CliInvocation,
  assistantId: string,
): Promise<DevicesListResult> {
  const result = await runDevicesCli(invocation, [
    "devices",
    assistantId,
    "--json",
  ]);
  if (!result.ok) {
    return result;
  }
  const devices = parseDeviceRecords(result.stdout);
  if (!devices) {
    const snippet = result.stdout.trim().slice(0, 200);
    return {
      ok: false,
      error: `CLI returned unparseable devices output: ${snippet}`,
    };
  }
  return { ok: true, devices };
}

export async function runDevicesRevoke(
  invocation: CliInvocation,
  assistantId: string,
  hashedDeviceId: string,
): Promise<DevicesRevokeResult> {
  const result = await runDevicesCli(invocation, [
    "devices",
    "revoke",
    hashedDeviceId,
    assistantId,
    "--yes",
    "--json",
  ]);
  return result.ok ? { ok: true } : result;
}
