import { spawn } from 'child_process';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface Step {
  name: string;
  run: () => Promise<void>;
}

function clearLine(): void {
  process.stdout.write('\r\x1b[K');
}

function showSpinner(name: string): NodeJS.Timeout {
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
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'pipe',
      env: options.env,
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`"${command} ${args.join(' ')}" exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

export function execOutput(
  command: string,
  args: string[],
  options: { cwd?: string } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`"${command} ${args.join(' ')}" exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}
