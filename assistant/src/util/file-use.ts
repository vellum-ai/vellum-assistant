import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ExecFileResult = { stdout: string };
type ExecFileRunner = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number },
) => Promise<ExecFileResult>;

const runExecFile: ExecFileRunner = async (command, args, options) => {
  const { stdout } = await execFileAsync(command, args, options);
  return { stdout };
};

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function errorStderr(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) {
    return "";
  }
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" ? stderr : "";
}

/** True only when lsof conclusively reports that no process holds the file. */
export async function isFileUnheld(
  path: string,
  run: ExecFileRunner = runExecFile,
): Promise<boolean> {
  try {
    const { stdout } = await run("lsof", ["-t", path], {
      encoding: "utf8",
      timeout: 3000,
    });
    return stdout.length === 0;
  } catch (error) {
    const code = errorCode(error);
    return (code === 1 || code === "1") && errorStderr(error).trim() === "";
  }
}
