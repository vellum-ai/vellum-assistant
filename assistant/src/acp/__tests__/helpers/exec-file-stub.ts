/**
 * Shared test helper: stub `execFile` from `node:child_process` for ACP tests.
 *
 * Several ACP suites (the adapter auto-installer and the `/v1/acp/spawn`
 * route) shell out via `execFileWithTimeout` (e.g. `bun add --global`). Each
 * test file used to duplicate the same `mock.module("node:child_process",
 * ...)` + scripted-responses boilerplate; this helper consolidates it,
 * mirroring `which-stub.ts`.
 *
 * The mock records every call's args, INCLUDING the options object (cwd, env,
 * ...) at `execFileMock.mock.calls[i][2]`, so tests can assert the installer's
 * sandboxed cwd and sanitized env.
 *
 * Like the other helpers here, the hook is process-global by design (Bun's
 * `mock.module` is process-global). Each test file should call
 * `installExecFileStub()` once at the top level, script calls per test via
 * `execScripts`, and clear state in `beforeEach` via `reset()`.
 */

import * as realChildProcess from "node:child_process";
import { mock } from "bun:test";

type ExecCallback = (
  err: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

export interface ExecScript {
  /** When set, the call rejects with this error. */
  error?: Error;
  /** When set, the call resolves with this stdout. */
  stdout?: string;
  /** When set, runs as the call executes (e.g. flip a which-stub flag). */
  onCall?: () => void;
}

type ExecFileMock = ReturnType<
  typeof mock<
    (
      command: string,
      args: string[],
      options: unknown,
      callback?: ExecCallback,
    ) => ReturnType<typeof realChildProcess.execFile>
  >
>;

export interface ExecFileStubHandle {
  /**
   * Per-call scripted responses, keyed by `${command} ${args[0]}` so tests
   * can target distinct subcommands (e.g. `<bunPath> add`) independently.
   * Calls with no script reject with a recognizable "No script for <key>"
   * error.
   */
  execScripts: Map<string, ExecScript>;
  execFileMock: ExecFileMock;
  /** Clears scripts and recorded calls. Call from `beforeEach`. */
  reset(): void;
}

/** Installs a process-global `execFile` mock. Returns handles to drive it. */
export function installExecFileStub(): ExecFileStubHandle {
  const execScripts: Map<string, ExecScript> = new Map();

  const execFileMock: ExecFileMock = mock(
    (
      command: string,
      args: string[],
      _options: unknown,
      callback?: ExecCallback,
    ) => {
      const key = `${command} ${args[0]}`;
      const script = execScripts.get(key);
      queueMicrotask(() => {
        if (!callback) return;
        if (!script) {
          callback(new Error(`No script for ${key}`), "", "");
          return;
        }
        script.onCall?.();
        if (script.error) {
          callback(script.error, "", "");
          return;
        }
        callback(null, script.stdout ?? "", "");
      });
      // Return value is not used by execFileWithTimeout.
      return {} as ReturnType<typeof realChildProcess.execFile>;
    },
  );

  mock.module("node:child_process", () => ({
    ...realChildProcess,
    execFile: execFileMock,
  }));

  return {
    execScripts,
    execFileMock,
    reset(): void {
      execScripts.clear();
      execFileMock.mockClear();
    },
  };
}
