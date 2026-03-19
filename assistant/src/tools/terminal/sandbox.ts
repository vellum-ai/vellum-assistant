import { getIsContainerized } from "../../config/env-registry.js";
import type { SandboxConfig } from "../../config/schema.js";
import { NativeBackend } from "./backends/native.js";
import type { SandboxResult, WrapOptions } from "./backends/types.js";

export type {
  SandboxBackend,
  SandboxResult,
  WrapOptions,
} from "./backends/types.js";

const nativeBackend = new NativeBackend();

const UNSANDBOXED_RESULT = (command: string): SandboxResult => ({
  command: "bash",
  args: ["-c", "--", command],
  sandboxed: false,
});

/**
 * Wrap a shell command for sandboxed execution.
 *
 * When sandboxing is disabled or the assistant is running inside a container
 * (IS_CONTAINERIZED), returns a plain bash invocation — the container itself
 * provides isolation and tools like bwrap typically cannot create the
 * namespaces they need inside a container.
 *
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
  if (!config.enabled || getIsContainerized()) {
    return UNSANDBOXED_RESULT(command);
  }

  return nativeBackend.wrap(command, workingDir, options);
}
