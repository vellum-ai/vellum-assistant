import { spawn } from "child_process";

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
        const msg = `"${command} ${args.join(" ")}" exited with code ${code}`;
        const output = [stderr.trim(), stdout.trim()]
          .filter(Boolean)
          .join("\n");
        reject(new Error(output ? `${msg}\n${output}` : msg));
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
        const msg = `"${command} ${args.join(" ")}" exited with code ${code}`;
        reject(new Error(stderr.trim() ? `${msg}\n${stderr.trim()}` : msg));
      }
    });
    child.on("error", reject);
  });
}
