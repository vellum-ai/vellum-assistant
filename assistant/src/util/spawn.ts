/**
 * Spawn a subprocess with a timeout.
 *
 * Resolves with the exit code, stdout, and stderr once the process exits.
 * Rejects if the process does not exit within `timeoutMs` milliseconds.
 */
export function spawnWithTimeout(
  cmd: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Process timed out after ${timeoutMs}ms: ${cmd[0]}`));
    }, timeoutMs);
    proc.exited.then(async (exitCode) => {
      clearTimeout(timer);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      resolve({ exitCode, stdout, stderr });
    });
  });
}
