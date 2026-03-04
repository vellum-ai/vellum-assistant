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
   * - 'off': network access is blocked (sandbox-exec deny network / bwrap --unshare-net). This is the default.
   * - 'proxied': network access is allowed so the process can reach the local credential proxy.
   */
  networkMode?: "off" | "proxied";
}

/**
 * A sandbox backend knows how to wrap a shell command so it runs
 * inside an OS-level sandbox (macOS sandbox-exec, Linux bwrap, etc.).
 */
export interface SandboxBackend {
  /** Wrap a command for sandboxed execution in the given working directory. */
  wrap(
    command: string,
    workingDir: string,
    options?: WrapOptions,
  ): SandboxResult;
}
