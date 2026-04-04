import { NativeBackend } from "./backends/native.js";
import type { SandboxResult, WrapOptions } from "./backends/types.js";

export interface SandboxConfig {
  enabled: boolean;
}

export type {
  SandboxBackend,
  SandboxResult,
  WrapOptions,
} from "./backends/types.js";

const nativeBackend = new NativeBackend();

/**
 * Wrap a shell command for sandboxed execution.
 *
 * When sandboxing is disabled, returns a plain bash invocation.
 * When enabled, delegates to the native backend.
 * Fails closed if the backend cannot be applied.
 *
 * @param options  Per-invocation overrides (e.g. networkMode for proxied bash).
 */
export function wrapCommand(
  command: string,
  workingDir: string,
  config: SandboxConfig,
  options?: WrapOptions,
): SandboxResult {
  if (!config.enabled) {
    return {
      command: "bash",
      args: ["-c", "--", command],
      sandboxed: false,
    };
  }

  return nativeBackend.wrap(command, workingDir, options);
}
