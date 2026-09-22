import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { shouldRestoreDesktopChromeSession } from "./desktop-chrome-session.js";

export const DESKTOP_CHROME_WINDOW_CLASS = "vellum-desktop-chrome";

export async function allocateDesktopDebugPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") {
    throw new Error("Cannot allocate desktop browser port");
  }
  return address.port;
}

export function validateDesktopWebSocket(value: unknown, port: number): string {
  if (typeof value !== "string") {
    throw new Error("Desktop browser discovery returned no endpoint");
  }
  const url = new URL(value);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== String(port) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(url.pathname)
  ) {
    throw new Error("Desktop browser discovery returned an unsafe endpoint");
  }
  return url.href;
}

// Match the listener to the managed Chrome process, including occupied-port races.
export async function assertDesktopListener(
  pid: number,
  port: number,
): Promise<void> {
  const table = await readFile(`/proc/${pid}/net/tcp`, "utf8");
  const address = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const inodes = new Set(
    table.split("\n").flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      return fields[1] === address && fields[3] === "0A" ? [fields[9]] : [];
    }),
  );
  const fds = await readdir(`/proc/${pid}/fd`);
  for (const fd of fds) {
    const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
    if (inodes.has(/^socket:\[(\d+)\]$/.exec(link)?.[1] ?? "")) {
      return;
    }
  }
  throw new Error(
    "Debug listener does not belong to the managed desktop Chrome",
  );
}

export async function findDesktopBrowserPid(
  executable: string,
  profileDir: string,
  port: number,
  procDir = "/proc",
): Promise<number | undefined> {
  try {
    const lock = await readlink(join(profileDir, "SingletonLock"));
    const pid = Number(/-(\d+)$/.exec(lock)?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return undefined;
    }
    const [expectedExecutable, actualExecutable, commandLine] =
      await Promise.all([
        realpath(executable),
        readlink(join(procDir, String(pid), "exe")),
        readFile(join(procDir, String(pid), "cmdline"), "utf8"),
      ]);
    const args = commandLine.split("\0");
    if (
      actualExecutable !== expectedExecutable ||
      !args.includes(`--user-data-dir=${profileDir}`) ||
      !args.includes(`--remote-debugging-port=${port}`) ||
      !args.includes("--remote-debugging-address=127.0.0.1") ||
      args.some((arg) => arg.startsWith("--type="))
    ) {
      return undefined;
    }
    return pid;
  } catch {
    return undefined;
  }
}

export async function discoverDesktopBrowser(
  pid: number,
  port: number,
  signal: AbortSignal,
): Promise<string> {
  await assertDesktopListener(pid, port);
  signal.throwIfAborted();
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error("Desktop browser discovery failed");
  }
  const body = await response.text();
  if (body.length > 16_384) {
    throw new Error("Desktop browser discovery exceeded its size limit");
  }
  const data = JSON.parse(body) as { webSocketDebuggerUrl?: unknown };
  await assertDesktopListener(pid, port);
  return validateDesktopWebSocket(data.webSocketDebuggerUrl, port);
}

export function desktopChromeArguments(
  profileDir: string,
  debugPort?: number,
): string[] {
  return [
    "--no-sandbox",
    "--no-first-run",
    `--class=${DESKTOP_CHROME_WINDOW_CLASS}`,
    "--force-renderer-accessibility",
    "--disable-dev-shm-usage",
    "--disable-features=Prerender2",
    ...(shouldRestoreDesktopChromeSession(profileDir)
      ? ["--restore-last-session", "--hide-crash-restore-bubble"]
      : []),
    "--start-maximized",
    `--user-data-dir=${profileDir}`,
    ...(debugPort
      ? [
          "--remote-debugging-address=127.0.0.1",
          `--remote-debugging-port=${debugPort}`,
        ]
      : []),
  ];
}
