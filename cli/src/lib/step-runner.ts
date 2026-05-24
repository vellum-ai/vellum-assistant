import { spawn } from "child_process";

/**
 * Build the error message for a failed child process. **Never include the
 * argv** — `docker run ...` invocations carry `-e ANTHROPIC_API_KEY=…` /
 * `-e OPENAI_API_KEY=…` style flags, and the resulting `Error.message`
 * propagates all the way to:
 *
 *   - the CLI's top-level catch (`console.error("Error:", err.message)`)
 *     which leaks them onto stderr,
 *   - `subprocess-*.log` files captured by the evals harness when it
 *     spawns `vellum hatch` (which then becomes the inlined log on the
 *     run-detail report page),
 *   - `run.json#error` and the last-N-lines tail in `progress.ndjson`
 *     that the evals harness emits for `SubprocessFailedError`.
 *
 * The diagnostic substring callers actually grep for ("no such container",
 * "is not running", "port is already allocated", …) lives in the child's
 * stderr/stdout, which we DO preserve below. Keep the command name only —
 * it's enough to disambiguate which step failed without quoting secrets.
 *
 * Exported so the unit test can assert no `-e KEY=...` slips back in.
 */
export function buildExecErrorMessage(
  command: string,
  code: number | null,
  stderr: string,
  stdout: string,
): string {
  const codeLabel = code === null ? "an unknown code" : `code ${code}`;
  const header = `${command} exited with ${codeLabel}`;
  const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  return output ? `${header}\n${output}` : header;
}

export function exec(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(buildExecErrorMessage(command, code, stderr, stdout)));
      }
    });
    child.on("error", reject);
  });
}

export function execOutput(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        // execOutput intentionally drops stdout from the error message
        // (callers that read stdout via the success path don't expect
        // partial stdout to land in error.message). Stderr is enough
        // for diagnostics, and the no-args-in-message guarantee from
        // exec() still holds.
        reject(new Error(buildExecErrorMessage(command, code, stderr, "")));
      }
    });
    child.on("error", reject);
  });
}
