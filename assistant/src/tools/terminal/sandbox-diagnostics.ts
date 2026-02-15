import { execSync, execFileSync } from 'node:child_process';
import { isMacOS, isLinux } from '../../util/platform.js';
import { getConfig } from '../../config/loader.js';
import type { SandboxConfig } from '../../config/schema.js';

export interface SandboxCheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface SandboxDiagnostics {
  config: {
    enabled: boolean;
    backend: string;
    dockerImage: string;
  };
  /** Why the active backend was selected (config vs platform default). */
  activeBackendReason: string;
  checks: SandboxCheckResult[];
}

function checkDockerCli(): SandboxCheckResult {
  try {
    const out = execSync('docker --version', { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }).trim();
    return { label: 'Docker CLI installed', ok: true, detail: out };
  } catch {
    return { label: 'Docker CLI installed', ok: false, detail: 'docker not found in PATH' };
  }
}

function checkDockerDaemon(): SandboxCheckResult {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    return { label: 'Docker daemon running', ok: true };
  } catch {
    return { label: 'Docker daemon running', ok: false, detail: 'daemon not reachable — start Docker Desktop or run "sudo systemctl start docker"' };
  }
}

function checkDockerImage(image: string): SandboxCheckResult {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'pipe', timeout: 10000 });
    return { label: `Docker image available (${image})`, ok: true };
  } catch {
    return { label: `Docker image available (${image})`, ok: false, detail: `pull with: docker pull ${image}` };
  }
}

function checkDockerRun(): SandboxCheckResult {
  try {
    const out = execFileSync(
      'docker',
      ['run', '--rm', 'ubuntu:22.04', 'echo', 'ok'],
      { stdio: 'pipe', timeout: 15000, encoding: 'utf-8' },
    ).trim();
    if (out === 'ok') {
      return { label: 'Docker container execution', ok: true };
    }
    return { label: 'Docker container execution', ok: false, detail: `unexpected output: ${out}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return { label: 'Docker container execution', ok: false, detail: msg };
  }
}

function checkNativeBackend(): SandboxCheckResult {
  if (isMacOS()) {
    try {
      execSync('sandbox-exec -n no-network true', { stdio: 'pipe', timeout: 5000 });
      return { label: 'Native sandbox (macOS sandbox-exec)', ok: true };
    } catch {
      return { label: 'Native sandbox (macOS sandbox-exec)', ok: false, detail: 'sandbox-exec not functional' };
    }
  }
  if (isLinux()) {
    try {
      execSync('bwrap --ro-bind / / --unshare-net --unshare-pid true', { stdio: 'pipe', timeout: 5000 });
      return { label: 'Native sandbox (Linux bwrap)', ok: true };
    } catch {
      return { label: 'Native sandbox (Linux bwrap)', ok: false, detail: 'bwrap not available — install bubblewrap' };
    }
  }
  return { label: 'Native sandbox', ok: false, detail: `not supported on ${process.platform}` };
}

function getActiveBackendReason(sandboxConfig: SandboxConfig): string {
  if (!sandboxConfig.enabled) {
    return 'Sandbox is disabled in configuration';
  }
  if (sandboxConfig.backend === 'docker') {
    return 'Docker backend selected in configuration (sandbox.backend = "docker")';
  }
  return 'Native backend selected in configuration (sandbox.backend = "native")';
}

/**
 * Run sandbox backend diagnostics. Checks Docker availability,
 * native backend availability, and reports current configuration.
 */
export function runSandboxDiagnostics(): SandboxDiagnostics {
  const config = getConfig();
  const sandboxConfig = config.sandbox;

  const checks: SandboxCheckResult[] = [];

  // Always check native backend availability as a diagnostic signal
  checks.push(checkNativeBackend());

  // Docker checks: CLI, daemon, image, container execution
  const cliResult = checkDockerCli();
  checks.push(cliResult);

  if (cliResult.ok) {
    const daemonResult = checkDockerDaemon();
    checks.push(daemonResult);

    if (daemonResult.ok) {
      checks.push(checkDockerImage(sandboxConfig.docker.image));
      checks.push(checkDockerRun());
    }
  }

  return {
    config: {
      enabled: sandboxConfig.enabled,
      backend: sandboxConfig.backend,
      dockerImage: sandboxConfig.docker.image,
    },
    activeBackendReason: getActiveBackendReason(sandboxConfig),
    checks,
  };
}
