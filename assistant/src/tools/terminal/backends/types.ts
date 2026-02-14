/** Result returned by a sandbox backend after wrapping a command. */
export interface SandboxResult {
  /** The command/args to use for spawning. */
  command: string;
  args: string[];
  /** Whether sandboxing was applied. */
  sandboxed: boolean;
}

/** Narrow interface for shell sandbox backends. */
export interface SandboxBackend {
  /** Wrap a shell command for sandboxed execution. */
  wrap(command: string, workingDir: string): SandboxResult;
}
