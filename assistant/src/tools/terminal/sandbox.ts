import { NativeBackend } from './backends/native.js';
import type { SandboxResult } from './backends/types.js';

export type { SandboxResult, SandboxBackend } from './backends/types.js';

const nativeBackend = new NativeBackend();

/**
 * Wrap a shell command for sandboxed execution.
 *
 * When sandboxing is disabled, returns a plain bash invocation.
 * When enabled, delegates to the native backend (macOS sandbox-exec
 * or Linux bwrap). Fails closed if the backend cannot be applied.
 */
export function wrapCommand(
  command: string,
  workingDir: string,
  enabled: boolean,
): SandboxResult {
  if (!enabled) {
    return {
      command: 'bash',
      args: ['-c', '--', command],
      sandboxed: false,
    };
  }

  return nativeBackend.wrap(command, workingDir);
}
