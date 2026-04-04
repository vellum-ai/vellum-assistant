import { execSync } from "node:child_process";

import { isLinux, isMacOS } from "../../util/platform.js";
import type { SandboxConfig } from "./sandbox.js";

export interface SandboxCheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface SandboxDiagnostics {
  config: {
    enabled: boolean;
  };
  /** Why the active backend was selected (config vs platform default). */
  activeBackendReason: string;
  checks: SandboxCheckResult[];
}

function checkNativeBackend(): SandboxCheckResult {
  if (isMacOS()) {
    try {
      execSync("sandbox-exec -n no-network true", {
        stdio: "pipe",
        timeout: 5000,
      });
      return { label: "Native sandbox (macOS sandbox-exec)", ok: true };
    } catch {
      return {
        label: "Native sandbox (macOS sandbox-exec)",
        ok: false,
        detail: "sandbox-exec not functional",
      };
    }
  }
  if (isLinux()) {
    try {
      execSync("bwrap --ro-bind / / --unshare-net --unshare-pid true", {
        stdio: "pipe",
        timeout: 5000,
      });
      return { label: "Native sandbox (Linux bwrap)", ok: true };
    } catch {
      return {
        label: "Native sandbox (Linux bwrap)",
        ok: false,
        detail: "bwrap not available - install bubblewrap",
      };
    }
  }
  return {
    label: "Native sandbox",
    ok: false,
    detail: `not supported on ${process.platform}`,
  };
}

function getActiveBackendReason(sandboxConfig: SandboxConfig): string {
  if (!sandboxConfig.enabled) {
    return "Sandbox is disabled in configuration";
  }
  return "Native backend selected";
}

/**
 * Run sandbox backend diagnostics. Checks native backend availability
 * and reports current configuration.
 */
export function runSandboxDiagnostics(): SandboxDiagnostics {
  // Sandbox is disabled — the assistant runs exclusively in Docker or
  // platform-managed environments.
  const sandboxConfig: SandboxConfig = { enabled: false };

  const checks: SandboxCheckResult[] = [];

  // Check native backend availability
  checks.push(checkNativeBackend());

  return {
    config: {
      enabled: sandboxConfig.enabled,
    },
    activeBackendReason: getActiveBackendReason(sandboxConfig),
    checks,
  };
}
