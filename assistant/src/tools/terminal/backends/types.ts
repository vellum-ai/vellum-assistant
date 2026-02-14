export interface SandboxResult {
  /** The command/args to use for spawning. */
  command: string;
  args: string[];
  /** Whether sandboxing was applied. */
  sandboxed: boolean;
}

/**
 * A sandbox backend knows how to wrap a shell command so it runs
 * inside an OS-level sandbox (macOS sandbox-exec, Linux bwrap, Docker, etc.).
 */
export interface SandboxBackend {
  /** Wrap a command for sandboxed execution in the given working directory. */
  wrap(command: string, workingDir: string): SandboxResult;
}
