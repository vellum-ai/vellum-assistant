import { readFile, readlink } from "node:fs/promises";

export async function verifyDesktopBrowserParent(
  expected: { chromePath: string; profileDir: string },
  display = process.env.DISPLAY,
  readProcess = async (pid: number) => ({
    executable: await readlink(`/proc/${pid}/exe`),
    args: (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0"),
    parent: Number(
      (await readFile(`/proc/${pid}/status`, "utf8")).match(
        /^PPid:\s+(\d+)/m,
      )?.[1],
    ),
  }),
): Promise<boolean> {
  if (display !== ":99") {
    return false;
  }
  let pid = process.ppid;
  for (let depth = 0; depth < 4 && pid > 1; depth++) {
    const parent = await readProcess(pid);
    if (
      parent.executable === expected.chromePath &&
      parent.args.includes(`--user-data-dir=${expected.profileDir}`) &&
      !parent.args.some((arg) => arg.startsWith("--type="))
    ) {
      return true;
    }
    pid = parent.parent;
  }
  return false;
}

// Chrome launches this bundled entrypoint with the calling extension origin.
async function main(): Promise<void> {
  const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
    token: string;
    gateway: string;
    extensionId: string;
    version: string;
    chromePath: string;
    profileDir: string;
  };
  if (process.argv[3] !== `chrome-extension://${config.extensionId}/`) {
    throw new Error("Unknown desktop extension origin");
  }
  if (!(await verifyDesktopBrowserParent(config))) {
    throw new Error("Unexpected desktop browser process");
  }
  const connection = crypto.randomUUID();
  const stop = new AbortController();
  const exchange = async (kind: string, message?: unknown) => {
    const response = await fetch(
      `${config.gateway}/v1/desktop/browser/bridge`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: config.token,
          connection,
          kind,
          message,
        }),
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]),
        redirect: "error",
      },
    );
    if (!response.ok) {
      throw new Error("Desktop browser connection rejected");
    }
    return response.json() as Promise<{ messages?: unknown[] }>;
  };
  let ready = false;
  let acceptHello!: () => void;
  const hello = new Promise<void>((resolve) => {
    acceptHello = resolve;
  });
  const helloTimeout = setTimeout(() => process.exit(1), 5000);
  let buffer = Buffer.alloc(0);
  let tail = Promise.resolve();
  let queued = 0;
  process.stdin.on("data", (chunk: Buffer) => {
    if (buffer.length + chunk.length > 4 * 1024 * 1024 + 4) {
      process.exit(1);
    }
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > 4 * 1024 * 1024) {
        process.exit(1);
      }
      if (buffer.length < length + 4) {
        break;
      }
      const message: unknown = JSON.parse(
        buffer.subarray(4, length + 4).toString(),
      );
      buffer = buffer.subarray(length + 4);
      if (!ready) {
        const greeting = message as {
          type?: unknown;
          version?: unknown;
          protocol?: unknown;
        };
        if (
          greeting?.type !== "desktop_browser_hello" ||
          greeting.version !== config.version ||
          greeting.protocol !== 1
        ) {
          process.exit(1);
        }
        ready = true;
        clearTimeout(helloTimeout);
        acceptHello();
        continue;
      }
      if (++queued > 128) {
        process.exit(1);
      }
      tail = tail
        .then(async () => {
          await exchange("message", message);
          queued--;
        })
        .catch(() => process.exit(1));
    }
  });
  process.stdin.on("end", () => {
    stop.abort();
    process.exit(0);
  });
  await hello;
  await exchange("connect");
  while (!stop.signal.aborted) {
    const response = await exchange("poll");
    for (const message of response.messages ?? []) {
      const bytes = Buffer.from(JSON.stringify(message));
      if (bytes.length > 1024 * 1024) {
        throw new Error("Desktop browser message is too large");
      }
      const length = Buffer.alloc(4);
      length.writeUInt32LE(bytes.length);
      process.stdout.write(Buffer.concat([length, bytes]));
    }
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(
      "Desktop native host:",
      err instanceof Error ? err.message : "connection failed",
    );
    process.exit(1);
  });
}
