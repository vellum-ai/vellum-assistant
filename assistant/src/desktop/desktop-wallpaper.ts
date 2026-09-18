import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { isResvgAvailable } from "../avatar/resvg-lazy.js";
import { resolveWorkerCommand } from "../util/worker-process.js";

const runFile = promisify(execFile);

export async function renderCurrentDesktopWallpaper(
  width: number,
  height: number,
): Promise<Buffer | null> {
  if (!isResvgAvailable()) {
    return null;
  }
  const directory = await mkdtemp(join(tmpdir(), "vellum-wallpaper-"));
  const output = join(directory, "wallpaper.png");
  try {
    const [executable, ...args] = resolveWorkerCommand(
      new URL("./desktop-wallpaper-worker.ts", import.meta.url),
      undefined,
    );
    await runFile(
      executable!,
      [...args, String(width), String(height), output],
      {
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
    );
    return await readFile(output).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
