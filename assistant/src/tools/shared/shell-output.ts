import { safeStringSlice } from "../../util/unicode.js";

export const MAX_OUTPUT_LENGTH = 20_000;

export const OUTPUT_TRUNCATED_TAG = `<output_truncated limit="20K" />`;

export interface ShellOutputResult {
  content: string;
  status: string | undefined;
  isError: boolean;
}

type StdioStream = "stdout" | "stderr";

type DataListener = (data: Buffer | string) => void;

type ReadableLike = {
  on(event: "data", listener: DataListener): unknown;
};

/**
 * Format already-materialized stdout/stderr into the tool result. Spawn sites
 * that read pipes should collect through {@link BoundedStdioCollector} so the
 * oversized tail never lands in memory. This helper still truncates a string
 * that is already over the cap (desktop host-bash payloads) without writing
 * the discarded tail to disk.
 */
export function formatShellOutput(
  stdout: string,
  stderr: string,
  code: number | null,
  timedOut: boolean,
  timeoutSec: number,
  options?: { truncated?: boolean },
): ShellOutputResult {
  let output = stdout;
  if (stderr) {
    output += (output ? "\n" : "") + stderr;
  }

  const statusParts: string[] = [];

  if (timedOut) {
    const msg = `<command_timeout seconds="${timeoutSec}" />`;
    output += `\n${msg}`;
    statusParts.push(msg);
  }

  const truncated =
    options?.truncated === true || output.length > MAX_OUTPUT_LENGTH;
  if (truncated) {
    output =
      safeStringSlice(output, 0, MAX_OUTPUT_LENGTH) +
      `\n${OUTPUT_TRUNCATED_TAG}`;
    statusParts.push(OUTPUT_TRUNCATED_TAG);
  }

  if (!output.trim()) {
    if (code === 0) {
      output = "<command_completed />";
    } else {
      const exitTag = `<command_exit code="${code}" />`;
      output = `${exitTag}\nCommand failed with exit code ${code}. No stdout or stderr output was produced.`;
      statusParts.push(exitTag);
    }
  } else if (code !== 0 && !timedOut) {
    statusParts.push(`<command_exit code="${code}" />`);
  }

  return {
    content: output,
    status: statusParts.length > 0 ? statusParts.join("\n") : undefined,
    isError: code !== 0 || timedOut,
  };
}

function toBuffer(data: Buffer | string): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  return Buffer.from(data);
}

/**
 * Caps bash stdout/stderr while they stream. Bytes past {@link MAX_OUTPUT_LENGTH}
 * are dropped (the process is left running so the pipe can drain). stdout and
 * stderr share one budget, matching the concatenated tool-result cap.
 */
export class BoundedStdioCollector {
  private readonly stdoutParts: Buffer[] = [];
  private readonly stderrParts: Buffer[] = [];
  private keptBytes = 0;
  private truncated = false;

  consume(
    stream: StdioStream,
    chunk: Buffer,
    onOutput?: (text: string) => void,
  ): void {
    if (this.truncated || chunk.length === 0) {
      return;
    }

    const remaining = MAX_OUTPUT_LENGTH - this.keptBytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }

    // Copy a prefix so a single oversized chunk can be GC'd. subarray()
    // would keep the whole allocation alive through the kept view.
    const kept =
      chunk.length <= remaining
        ? chunk
        : Buffer.from(chunk.subarray(0, remaining));
    if (stream === "stdout") {
      this.stdoutParts.push(kept);
    } else {
      this.stderrParts.push(kept);
    }
    this.keptBytes += kept.length;
    if (kept.length < chunk.length) {
      this.truncated = true;
    }
    onOutput?.(kept.toString());
  }

  get keptByteLength(): number {
    return this.keptBytes;
  }

  get didTruncate(): boolean {
    return this.truncated;
  }

  format(
    code: number | null,
    timedOut: boolean,
    timeoutSec: number,
  ): ShellOutputResult {
    return formatShellOutput(
      Buffer.concat(this.stdoutParts).toString(),
      Buffer.concat(this.stderrParts).toString(),
      code,
      timedOut,
      timeoutSec,
      { truncated: this.truncated },
    );
  }
}

/** Attach a shared-budget collector to a child's stdout and stderr pipes. */
export function attachBoundedStdio(
  child: { stdout?: ReadableLike | null; stderr?: ReadableLike | null },
  options?: { onOutput?: (text: string) => void },
): BoundedStdioCollector {
  const collector = new BoundedStdioCollector();
  child.stdout?.on("data", (data) => {
    collector.consume("stdout", toBuffer(data), options?.onOutput);
  });
  child.stderr?.on("data", (data) => {
    collector.consume("stderr", toBuffer(data), options?.onOutput);
  });
  return collector;
}
