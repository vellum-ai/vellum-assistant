import { execFile } from "node:child_process";

import {
  DESKTOP_DISPLAY,
  DESKTOP_INPUT_PARAMETERS,
} from "./desktop-display.js";

export function runDesktopCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
  input?: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      `/usr/bin/${command}`,
      args,
      {
        env: {
          PATH: "/usr/bin:/bin",
          DISPLAY: DESKTOP_DISPLAY,
          LANG: "C.UTF-8",
        },
        encoding: "buffer",
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
        killSignal: "SIGKILL",
        windowsHide: true,
        signal,
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export class DesktopViewerInput {
  constructor(protected readonly runCommand = runDesktopCommand) {}
  async setViewerInput(enabled: boolean): Promise<void> {
    const value = enabled ? "1" : "0";
    await this.runCommand("tigervncconfig", [
      "-set",
      ...DESKTOP_INPUT_PARAMETERS.map((name) => `${name}=${value}`),
    ]);
    for (const name of DESKTOP_INPUT_PARAMETERS) {
      const actual = await this.runCommand("tigervncconfig", ["-get", name]);
      if (
        !new Set(enabled ? ["1", "true", "on"] : ["0", "false", "off"]).has(
          actual.toString().trim().toLowerCase(),
        )
      ) {
        throw new Error(`Could not update desktop input: ${name}`);
      }
    }
  }
}
