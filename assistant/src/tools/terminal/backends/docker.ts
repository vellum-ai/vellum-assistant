import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative, posix } from 'node:path';
import { ToolError } from '../../../util/errors.js';
import { getLogger } from '../../../util/logger.js';
import type { SandboxBackend, SandboxResult } from './types.js';

const log = getLogger('docker-sandbox');

export interface DockerConfig {
  image?: string;
  cpus?: number;
  memoryMb?: number;
  pidsLimit?: number;
  network?: string;
}

const DEFAULTS: Required<DockerConfig> = {
  image: 'ubuntu:22.04',
  cpus: 2,
  memoryMb: 512,
  pidsLimit: 256,
  network: 'none',
};

/**
 * Cache positive preflight results only, matching the bwrap pattern in native.ts.
 * Negative results are not cached so that installing/starting Docker after the
 * daemon starts takes effect without a restart.
 */
let dockerCliAvailable = false;
let dockerDaemonReachable = false;
const imageAvailableCache = new Set<string>();
const mountProbeCache = new Set<string>();

/** Exported for tests to reset cached state between runs. */
export function _resetDockerChecks(): void {
  dockerCliAvailable = false;
  dockerDaemonReachable = false;
  imageAvailableCache.clear();
  mountProbeCache.clear();
}

function checkDockerCli(): void {
  if (dockerCliAvailable) return;
  try {
    execSync('docker --version', { stdio: 'ignore', timeout: 5000 });
    dockerCliAvailable = true;
  } catch {
    throw new ToolError(
      'Docker CLI is not installed or not in PATH. Install Docker: https://docs.docker.com/get-docker/',
      'bash',
    );
  }
}

function checkDockerDaemon(): void {
  if (dockerDaemonReachable) return;
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 10000 });
    dockerDaemonReachable = true;
  } catch {
    throw new ToolError(
      'Docker daemon is not running. Start Docker Desktop or run "sudo systemctl start docker".',
      'bash',
    );
  }
}

function checkImageAvailable(image: string): void {
  if (imageAvailableCache.has(image)) return;
  try {
    execSync(`docker image inspect ${image}`, { stdio: 'ignore', timeout: 10000 });
    imageAvailableCache.add(image);
  } catch {
    throw new ToolError(
      `Docker image "${image}" is not available locally. Pull it first: docker pull ${image}`,
      'bash',
    );
  }
}

function checkMountProbe(sandboxRoot: string): void {
  if (mountProbeCache.has(sandboxRoot)) return;
  try {
    execSync(
      `docker run --rm --mount type=bind,src=${sandboxRoot},dst=/workspace ubuntu:22.04 test -w /workspace`,
      { stdio: 'ignore', timeout: 15000 },
    );
    mountProbeCache.add(sandboxRoot);
  } catch {
    throw new ToolError(
      `Cannot bind-mount "${sandboxRoot}" into a Docker container or /workspace is not writable. ` +
      'If using Docker Desktop, enable file sharing for this path in Settings > Resources > File Sharing.',
      'bash',
    );
  }
}

/**
 * Docker sandbox backend that wraps commands in ephemeral containers.
 *
 * Each invocation produces a single `docker run --rm` command — no long-lived
 * container state. The sandbox filesystem root is bind-mounted to /workspace
 * and the host UID:GID is forwarded to prevent permission drift.
 *
 * On first use, runs preflight checks (CLI, daemon, image, mount probe) and
 * fails closed with actionable error messages if any check fails.
 */
export class DockerBackend implements SandboxBackend {
  private readonly sandboxRoot: string;
  private readonly config: Required<DockerConfig>;
  private readonly uid: number;
  private readonly gid: number;

  constructor(
    sandboxRoot: string,
    config?: DockerConfig,
    uid?: number,
    gid?: number,
  ) {
    this.sandboxRoot = realpathSync(sandboxRoot);
    this.config = { ...DEFAULTS, ...config };
    this.uid = uid ?? process.getuid!();
    this.gid = gid ?? process.getgid!();
  }

  /**
   * Run preflight checks in dependency order. Each check is cached
   * on success; failures re-check on every call.
   */
  preflight(): void {
    checkDockerCli();
    checkDockerDaemon();
    checkImageAvailable(this.config.image);
    checkMountProbe(this.sandboxRoot);
  }

  wrap(command: string, workingDir: string): SandboxResult {
    // Preflight: fail closed if Docker is not usable.
    this.preflight();

    const realWorkDir = realpathSync(workingDir);
    const realRoot = this.sandboxRoot;

    // Fail closed: working dir must be inside sandbox root.
    if (!realWorkDir.startsWith(realRoot + '/') && realWorkDir !== realRoot) {
      log.error(
        'Working directory %s is outside sandbox root %s',
        realWorkDir,
        realRoot,
      );
      throw new ToolError(
        `Working directory "${realWorkDir}" is outside the sandbox root "${realRoot}". Refusing to execute.`,
        'bash',
      );
    }

    // Map host working dir to container path under /workspace.
    const relPath = relative(realRoot, realWorkDir);
    const containerWorkDir =
      relPath === '' ? '/workspace' : posix.join('/workspace', relPath);

    const { image, cpus, memoryMb, pidsLimit, network } = this.config;

    const args: string[] = [
      'run',
      '--rm',
      `--network=${network}`,
      `--cpus=${cpus}`,
      `--memory=${memoryMb}m`,
      `--pids-limit=${pidsLimit}`,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--mount',
      `type=bind,src=${realRoot},dst=/workspace`,
      '--workdir',
      containerWorkDir,
      '--user',
      `${this.uid}:${this.gid}`,
      image,
      'bash',
      '-c',
      '--',
      command,
    ];

    return { command: 'docker', args, sandboxed: true };
  }
}
