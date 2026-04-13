import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { safeStringSlice } from "../../util/unicode.js";

export const MAX_OUTPUT_LENGTH = 20_000;

/** Tracks temp files created for truncated shell output so they can be cleaned up on shutdown. */
const trackedTempFiles = new Set<string>();

/** Remove all tracked truncated-output temp files. Safe to call multiple times. */
export function cleanupShellOutputTempFiles(): void {
  for (const filePath of trackedTempFiles) {
    try {
      unlinkSync(filePath);
    } catch {
      // File may already be gone — ignore.
    }
  }
  trackedTempFiles.clear();
}

export interface ShellOutputResult {
  content: string;
  status: string | undefined;
  isError: boolean;
}

/**
 * Format the raw stdout/stderr/exit-code from a spawned shell command into the
 * final tool result.  Both `shell.ts` (sandbox bash) and `host-shell.ts`
 * (host_bash) must produce identical output formatting - this shared function
 * is the single source of truth for that logic.
 */
export function formatShellOutput(
  stdout: string,
  stderr: string,
  code: number | null,
  timedOut: boolean,
  timeoutSec: number,
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

  if (output.length > MAX_OUTPUT_LENGTH) {
    let fullOutputPath: string | undefined;
    try {
      fullOutputPath = join(tmpdir(), `vellum-shell-output-${randomUUID()}.txt`);
      writeFileSync(fullOutputPath, output, { encoding: "utf-8", mode: 0o600 });
      trackedTempFiles.add(fullOutputPath);
    } catch {
      fullOutputPath = undefined;
    }
    const fileAttr = fullOutputPath ? ` file="${fullOutputPath}"` : "";
    const msg = `<output_truncated limit="20K"${fileAttr} />`;
    output = safeStringSlice(output, 0, MAX_OUTPUT_LENGTH) + `\n${msg}`;
    statusParts.push(msg);
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
