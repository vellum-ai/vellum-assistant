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
 * Docker sandbox backend that wraps commands in ephemeral containers.
 *
 * Each invocation produces a single `docker run --rm` command — no long-lived
 * container state. The sandbox filesystem root is bind-mounted to /workspace
 * and the host UID:GID is forwarded to prevent permission drift.
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

  wrap(command: string, workingDir: string): SandboxResult {
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
