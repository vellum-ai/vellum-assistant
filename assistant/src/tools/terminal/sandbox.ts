import { NativeBackend } from './backends/native.js';
import { DockerBackend } from './backends/docker.js';
import type { SandboxResult } from './backends/types.js';
import type { SandboxConfig } from '../../config/schema.js';

export type { SandboxResult, SandboxBackend } from './backends/types.js';

const nativeBackend = new NativeBackend();

/**
 * Wrap a shell command for sandboxed execution.
 *
 * When sandboxing is disabled, returns a plain bash invocation.
 * When enabled, delegates to the configured backend (native or docker).
 * Fails closed if the backend cannot be applied.
 */
export function wrapCommand(
  command: string,
  workingDir: string,
  config: SandboxConfig,
): SandboxResult {
  if (!config.enabled) {
    return {
      command: 'bash',
      args: ['-c', '--', command],
      sandboxed: false,
    };
  }

  if (config.backend === 'docker') {
    const backend = new DockerBackend(workingDir, config.docker);
    return backend.wrap(command, workingDir);
  }

  return nativeBackend.wrap(command, workingDir);
}
