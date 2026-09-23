import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { desktopChromePath } from "../../desktop/desktop-dependencies.js";
import {
  type CdpWsTransport,
  connectCdpWsTransport,
} from "../../tools/browser/cdp-client/cdp-inspect/ws-transport.js";

function chromeExecutable(): string {
  const candidates =
    process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32"
        ? [
            process.env.PROGRAMFILES,
            process.env["PROGRAMFILES(X86)"],
            process.env.LOCALAPPDATA,
          ]
            .filter((path): path is string => Boolean(path))
            .map((path) =>
              join(path, "Google", "Chrome", "Application", "chrome.exe"),
            )
        : [
            desktopChromePath(),
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
          ];
  const executable = candidates.find((path) => existsSync(path));
  if (!executable) {
    throw new Error(
      "PDF export requires Google Chrome. Install Chrome or update the assistant image.",
    );
  }
  return executable;
}

export async function withPdfChrome<T>(
  render: (transport: CdpWsTransport, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const executable = chromeExecutable();
  const profile = await mkdtemp(join(tmpdir(), "vellum-pdf-"));
  let transport: CdpWsTransport | undefined;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(60_000),
  ]);
  const child = spawn(
    executable,
    [
      "--headless",
      "--no-first-run",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--disable-dev-shm-usage",
      ...(process.platform === "linux" && process.getuid?.() === 0
        ? ["--no-sandbox"]
        : []),
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => controller.abort(error));
    child.once("exit", () => controller.abort(new Error("PDF browser exited")));
    child.once("close", () => resolve());
  });
  try {
    let endpoint: string | undefined;
    while (!endpoint) {
      signal.throwIfAborted();
      const activePort = await readFile(
        join(profile, "DevToolsActivePort"),
        "utf8",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
        return "";
      });
      const [port, path] = activePort.trim().split("\n");
      if (
        /^\d+$/.test(port ?? "") &&
        /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path ?? "")
      ) {
        endpoint = `ws://127.0.0.1:${port}${path}`;
      } else {
        await delay(25, undefined, { signal });
      }
    }
    transport = await connectCdpWsTransport(endpoint, { signal });
    return await render(transport, signal);
  } finally {
    transport?.dispose();
    child.kill("SIGKILL");
    await exited;
    await rm(profile, { recursive: true, force: true });
  }
}
