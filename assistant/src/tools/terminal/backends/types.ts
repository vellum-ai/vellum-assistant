export interface SandboxResult {
  /** The command/args to use for spawning. */
  command: string;
  args: string[];
  /** Whether sandboxing was applied. */
  sandboxed: boolean;
}

/** Per-invocation options that override backend defaults. */
export interface WrapOptions {
  /**
   * Network mode for this invocation.
   * - 'off': no container network (--network=none). This is the default.
   * - 'proxied': bridge network so the container can reach a host proxy (--network=bridge).
   */
  networkMode?: 'off' | 'proxied';
}

/**
 * A sandbox backend knows how to wrap a shell command so it runs
 * inside an OS-level sandbox (macOS sandbox-exec, Linux bwrap, Docker, etc.).
 */
export interface SandboxBackend {
  /** Wrap a command for sandboxed execution in the given working directory. */
  wrap(command: string, workingDir: string, options?: WrapOptions): SandboxResult;
}
