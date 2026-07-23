import { spawn } from "child_process";

const MAX_RESTARTS = 5;
const BASE_RESTART_DELAY_MS = 1_000;

interface SupervisedProcessConfig {
  command: string;
  args: string[];
  cwd?: string;
  label: string;
}

function readConfig(): SupervisedProcessConfig {
  const raw = process.env.VELLUM_SUPERVISED_PROCESS;
  if (!raw) {
    throw new Error("Missing supervised process configuration");
  }

  const config = JSON.parse(raw) as Partial<SupervisedProcessConfig>;
  if (
    typeof config.command !== "string" ||
    !Array.isArray(config.args) ||
    !config.args.every((arg) => typeof arg === "string") ||
    typeof config.label !== "string"
  ) {
    throw new Error("Invalid supervised process configuration");
  }

  return {
    command: config.command,
    args: config.args,
    cwd: typeof config.cwd === "string" ? config.cwd : undefined,
    label: config.label,
  };
}

export async function supervise(): Promise<void> {
  const config = readConfig();
  const childEnv = { ...process.env };
  delete childEnv.VELLUM_SUPERVISED_PROCESS;
  let child: ReturnType<typeof spawn> | undefined;
  let shuttingDown = false;

  const forwardSignal = (signal: NodeJS.Signals): void => {
    shuttingDown = true;
    if (!child?.kill(signal)) {
      return;
    }
    setTimeout(() => child?.kill("SIGKILL"), 1_500).unref();
  };
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));

  for (let restartCount = 0; ; restartCount++) {
    child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: childEnv,
      stdio: "inherit",
    });

    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });

    if (shuttingDown || result.code === 0) {
      process.exitCode = result.code ?? 0;
      return;
    }

    if (restartCount >= MAX_RESTARTS) {
      console.error(
        `${config.label} crashed ${MAX_RESTARTS + 1} times; automatic restarts are disabled until the next wake.`,
      );
      process.exitCode = result.code ?? 1;
      return;
    }

    const delayMs = BASE_RESTART_DELAY_MS * 2 ** restartCount;
    console.error(
      `${config.label} crashed; restarting in ${delayMs / 1_000}s (${restartCount + 1}/${MAX_RESTARTS}).`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
