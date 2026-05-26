export type ClipboardMethod = "osc52" | "pbcopy";
export type ClipboardFailureReason = "empty" | "unsupported";

export interface ClipboardResult {
  copied: boolean;
  method?: ClipboardMethod;
  reason?: ClipboardFailureReason;
}

export interface ClipboardWriter {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface CommandRunnerResult {
  success: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  input: string,
) => Promise<CommandRunnerResult>;

export interface CopyTextOptions {
  stdout?: ClipboardWriter;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
}

const OSC52_CLIPBOARD = "c";

function osc52Sequence(text: string): string {
  const encoded = Buffer.from(text, "utf-8").toString("base64");
  return `\x1b]52;${OSC52_CLIPBOARD};${encoded}\x07`;
}

function supportsOsc52(
  stdout: ClipboardWriter | undefined,
  env: NodeJS.ProcessEnv,
): stdout is ClipboardWriter {
  if (!stdout?.isTTY) return false;
  if ((env.TERM ?? "").toLowerCase() === "dumb") return false;
  if (env.VELLUM_DISABLE_OSC52 === "1") return false;
  return true;
}

async function defaultRunCommand(
  command: string,
  args: string[],
  input: string,
): Promise<CommandRunnerResult> {
  const proc = Bun.spawn([command, ...args], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const exitCode = await proc.exited;
  return { success: exitCode === 0 };
}

export async function copyTextToClipboard(
  text: string,
  options: CopyTextOptions = {},
): Promise<ClipboardResult> {
  if (text.length === 0) {
    return { copied: false, reason: "empty" };
  }

  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;

  if (supportsOsc52(stdout, env)) {
    stdout.write(osc52Sequence(text));
    return { copied: true, method: "osc52" };
  }

  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const runner = options.runCommand ?? defaultRunCommand;
    const result = await runner("pbcopy", [], text);
    if (result.success) {
      return { copied: true, method: "pbcopy" };
    }
  }

  return { copied: false, reason: "unsupported" };
}
