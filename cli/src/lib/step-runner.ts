import { spawn } from "child_process";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface Step {
  name: string;
  run: () => Promise<void>;
}

export function clearLine(): void {
  process.stdout.write("\r\x1b[K");
}

export function showSpinner(name: string): NodeJS.Timeout {
  let frameIndex = 0;
  return setInterval(() => {
    clearLine();
    process.stdout.write(`  ${SPINNER_FRAMES[frameIndex]} ${name}...`);
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  }, 80);
}

export async function runSteps(steps: Step[]): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = `[${i + 1}/${steps.length}] ${step.name}`;

    const spinner = showSpinner(label);

    try {
      await step.run();
      clearInterval(spinner);
      clearLine();
      console.log(`  ✔ ${label}`);
    } catch (error) {
      clearInterval(spinner);
      clearLine();
      console.log(`  ✖ ${label}`);
      throw error;
    }
  }
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

    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const msg = `"${command} ${args.join(" ")}" exited with code ${code}`;
        reject(new Error(stderr.trim() ? `${msg}\n${stderr.trim()}` : msg));
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
