import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, relative, posix } from 'node:path';
import { ToolError } from '../../../util/errors.js';
import { getLogger } from '../../../util/logger.js';
import type { DockerConfig } from '../../../config/types.js';
import type { SandboxBackend, SandboxResult } from './types.js';

const log = getLogger('docker-sandbox');

/**
 * Fallback defaults when DockerBackend is constructed without explicit config.
 * Must stay in sync with DockerConfigSchema defaults in config/schema.ts.
 */
const DEFAULTS: Required<DockerConfig> = {
  image: 'node:20-slim@sha256:c6585df72c34172bebd8d36abed961e231d7d3b5cee2e01294c4495e8a03f687',
  shell: 'bash',
  cpus: 1,
  memoryMb: 512,
  pidsLimit: 256,
  network: 'none',
};

/**
 * Characters that are dangerous in Docker mount arguments or shell commands.
 * Commas are included because Docker's --mount flag uses them as field
 * delimiters — a path containing a comma could inject extra key=value pairs
 * (e.g. overriding dst= or src=) into the mount specification.
 */
const UNSAFE_PATH_CHARS = /[\x00\n\r,]/;

/**
 * Cache positive preflight results only, matching the bwrap pattern in native.ts.
 * Negative results are not cached so that installing/starting Docker after the
 * daemon starts takes effect without a restart.
 */
let dockerCliAvailable = false;
let dockerDaemonReachable = false;
const imageAvailableCache = new Set<string>();
const mountProbeCache = new Set<string>();
/** Maps image → resolved shell path (e.g. 'bash' → 'bash', or fell back to 'sh'). */
const shellResolvedCache = new Map<string, string>();

/** Exported for tests to reset cached state between runs. */
export function _resetDockerChecks(): void {
  dockerCliAvailable = false;
  dockerDaemonReachable = false;
  imageAvailableCache.clear();
  mountProbeCache.clear();
  shellResolvedCache.clear();
}

function checkDockerCli(): void {
  if (dockerCliAvailable) return;
  try {
    execFileSync('docker', ['--version'], { stdio: 'ignore', timeout: 5000 });
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
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10000 });
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
    // Use execFileSync to avoid shell interpolation of the image name.
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 10000 });
    imageAvailableCache.add(image);
  } catch {
    throw new ToolError(
      `Docker image "${image}" is not available locally. Pull it first: docker pull ${image}`,
      'bash',
    );
  }
}

function checkMountProbe(sandboxRoot: string, image: string): void {
  const cacheKey = `${sandboxRoot}\0${image}`;
  if (mountProbeCache.has(cacheKey)) return;
  try {
    execFileSync(
      'docker',
      [
        'run', '--rm',
        '--mount', `type=bind,src=${sandboxRoot},dst=/workspace`,
        image, 'test', '-w', '/workspace',
      ],
      { stdio: 'ignore', timeout: 15000 },
    );
    mountProbeCache.add(cacheKey);
  } catch {
    throw new ToolError(
      'Cannot bind-mount the sandbox root into a Docker container or /workspace is not writable. ' +
      'If using Docker Desktop, enable file sharing for this path in Settings > Resources > File Sharing.',
      'bash',
    );
  }
}

/**
 * Verify the configured shell exists in the image.  If the requested shell
 * (e.g. 'bash') is missing, fall back to 'sh' which is available on virtually
 * every Linux image.  If neither exists the image is too minimal to use.
 */
function resolveShell(image: string, shell: string): string {
  const cacheKey = `${image}\0${shell}`;
  const cached = shellResolvedCache.get(cacheKey);
  if (cached) return cached;

  // Try the configured shell first.
  try {
    execFileSync('docker', ['run', '--rm', image, shell, '-c', 'true'], {
      stdio: 'ignore',
      timeout: 15000,
    });
    shellResolvedCache.set(cacheKey, shell);
    return shell;
  } catch {
    // configured shell not available — try sh fallback
  }

  if (shell === 'sh') {
    throw new ToolError(
      `Shell "sh" is not available in Docker image "${image}". The image may be too minimal for sandbox use.`,
      'bash',
    );
  }

  try {
    execFileSync('docker', ['run', '--rm', image, 'sh', '-c', 'true'], {
      stdio: 'ignore',
      timeout: 15000,
    });
    log.warn(`Shell "${shell}" not found in image "${image}", falling back to "sh"`);
    shellResolvedCache.set(cacheKey, 'sh');
    return 'sh';
  } catch {
    throw new ToolError(
      `Neither "${shell}" nor "sh" is available in Docker image "${image}". ` +
      'Choose a different image or set sandbox.docker.shell to a shell that exists in the image.',
      'bash',
    );
  }
}

/**
 * Validate that a path is safe to use in Docker mount arguments.
 * Rejects paths containing null bytes, newlines, or carriage returns which
 * could cause argument injection or parsing issues.
 */
function validatePathSafety(path: string, label: string): void {
  if (UNSAFE_PATH_CHARS.test(path)) {
    throw new ToolError(
      `${label} contains characters that are unsafe for Docker mount arguments. ` +
      'Refusing to execute. Remove null bytes, newlines, carriage returns, or commas from the path.',
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
    config?: Partial<Required<DockerConfig>>,
    uid?: number,
    gid?: number,
  ) {
    // Resolve to an absolute path first, then follow symlinks.
    // This prevents path traversal via ../.. or symlink tricks.
    const resolved = resolve(sandboxRoot);
    this.sandboxRoot = realpathSync(resolved);
    validatePathSafety(this.sandboxRoot, 'Sandbox root');
    this.config = { ...DEFAULTS, ...config };
    if (uid != null) {
      this.uid = uid;
    } else if (process.getuid) {
      this.uid = process.getuid();
    } else {
      throw new ToolError(
        'Docker sandbox requires POSIX UID/GID APIs (process.getuid/getgid) which are not available on this platform.',
        'bash',
      );
    }
    this.gid = gid ?? (process.getgid ? process.getgid() : this.uid);
  }

  /**
   * Run preflight checks in dependency order. Each check is cached
   * on success; failures re-check on every call.  Returns the resolved
   * shell (may differ from config if the configured shell is missing).
   */
  preflight(): string {
    checkDockerCli();
    checkDockerDaemon();
    checkImageAvailable(this.config.image);
    checkMountProbe(this.sandboxRoot, this.config.image);
    return resolveShell(this.config.image, this.config.shell);
  }

  wrap(command: string, workingDir: string): SandboxResult {
    // Preflight: fail closed if Docker is not usable.
    const shell = this.preflight();

    // Resolve + follow symlinks for the working directory.
    const resolved = resolve(workingDir);
    const realWorkDir = realpathSync(resolved);
    const realRoot = this.sandboxRoot;

    // Validate path safety for mount/workdir args.
    validatePathSafety(realWorkDir, 'Working directory');

    // Fail closed: working dir must be inside sandbox root.
    if (!realWorkDir.startsWith(realRoot + '/') && realWorkDir !== realRoot) {
      log.error(
        'Working directory is outside sandbox root — refusing to execute',
      );
      throw new ToolError(
        'Working directory is outside the sandbox root. Refusing to execute.',
        'bash',
      );
    }

    // Map host working dir to container path under /workspace.
    const relPath = relative(realRoot, realWorkDir);
    const containerWorkDir =
      relPath === '' ? '/workspace' : posix.join('/workspace', relPath);

    const { image, cpus, memoryMb, pidsLimit, network } = this.config;

    // Every flag is a separate argv segment — no shell interpolation occurs.
    const args: string[] = [
      'run',
      '--rm',
      `--network=${network}`,
      `--cpus=${cpus}`,
      `--memory=${memoryMb}m`,
      `--pids-limit=${pidsLimit}`,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      // Read-only container root prevents writes outside explicit mounts.
      '--read-only',
      // Writable tmpfs for /tmp — required for shell behavior, temp files, etc.
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec',
      '--mount',
      `type=bind,src=${realRoot},dst=/workspace`,
      '--workdir',
      containerWorkDir,
      '--user',
      `${this.uid}:${this.gid}`,
      image,
      shell,
      '-c',
      command,
    ];

    return { command: 'docker', args, sandboxed: true };
  }
}
