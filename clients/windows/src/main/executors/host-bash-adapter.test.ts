import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";

import { HostProxyPoster } from "@vellumai/electron-desktop/host-proxy/poster";
import { __testing as executorTesting } from "@vellumai/electron-desktop/host-proxy/executors/host-shell-executor";

import { createWindowsHostBashExecutor } from "./host-bash-adapter";

// On Windows the real powershell.exe is exercised; elsewhere (macOS dev
// machines, ubuntu CI) PowerShell Core stands in when installed. The
// -EncodedCommand invocation shape is identical for both.
const localPowerShell =
  process.platform === "win32" ? "powershell.exe" : Bun.which("pwsh");
const hasPowerShell = localPowerShell !== null;

const executor = createWindowsHostBashExecutor(localPowerShell ?? undefined);

// PowerShell cold starts are slow, so completion is polled rather than slept
// for, and the slow tests carry explicit bun test timeouts.
const TEST_TIMEOUT_MS = 30_000;

async function waitFor(
  condition: () => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface CapturedPost {
  url: string;
  body: Record<string, unknown>;
}

function capturingPoster(): {
  poster: InstanceType<typeof HostProxyPoster>;
  posts: () => CapturedPost[];
} {
  const captured: CapturedPost[] = [];
  const fakeFetch = async (url: unknown, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse(init?.body as string) });
    return new Response("ok");
  };
  const poster = new HostProxyPoster({
    endpointBase: "http://127.0.0.1:9000/v1",
    authHeaders: () => ({ Authorization: "Bearer t" }),
    fetch: fakeFetch as typeof globalThis.fetch,
  });
  return { poster, posts: () => captured };
}

async function runToResult(
  command: string,
  requestId: string,
  extras: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { poster, posts } = capturingPoster();
  executor.handleRequest(
    { type: "host_bash_request", requestId, command, ...extras },
    poster,
  );
  await waitFor(() => posts().length > 0);
  expect(posts().length).toBe(1);
  return posts()[0].body;
}

describe("windows host-bash adapter", () => {
  afterEach(() => {
    for (const [, entry] of executorTesting.runningProcesses) {
      try {
        entry.child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }
    executorTesting.runningProcesses.clear();
  });

  test.skipIf(!hasPowerShell)(
    "executes a command and posts the result",
    async () => {
      const result = await runToResult("Write-Output hello", "w1");
      expect(result.requestId).toBe("w1");
      expect((result.stdout as string).trim()).toBe("hello");
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!hasPowerShell)(
    "preserves quoting and dollar signs through the encoded command",
    async () => {
      const result = await runToResult(
        '$x = "spaced `"inner`" value"; Write-Output "got: $x"',
        "w2",
      );
      expect((result.stdout as string).trim()).toBe(
        'got: spaced "inner" value',
      );
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!hasPowerShell)(
    "round-trips Unicode output",
    async () => {
      // The command sets no encoding itself; the adapter's UTF-8 preamble
      // must keep non-ASCII output intact.
      const result = await runToResult("Write-Output 'héllo wörld'", "w3");
      expect((result.stdout as string).trim()).toBe("héllo wörld");
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!hasPowerShell)(
    "reports a nonzero exit code",
    async () => {
      const result = await runToResult("exit 42", "w4");
      expect(result.exitCode).toBe(42);
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!hasPowerShell)(
    "uses the requested working directory",
    async () => {
      const workingDir = os.tmpdir();
      const result = await runToResult(
        "Write-Output (Get-Location).Path",
        "w5",
        { working_dir: workingDir },
      );
      const reported = (result.stdout as string).trim();
      expect([workingDir, `/private${workingDir}`]).toContain(reported);
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!hasPowerShell)(
    "cancellation terminates the process and suppresses the result",
    async () => {
      const { poster, posts } = capturingPoster();

      executor.handleRequest(
        {
          type: "host_bash_request",
          requestId: "w6",
          command: "Start-Sleep -Seconds 60",
        },
        poster,
      );

      await waitFor(() => executorTesting.runningProcesses.has("w6"));
      expect(executorTesting.runningProcesses.has("w6")).toBe(true);

      executor.handleCancel(
        { type: "host_bash_cancel", requestId: "w6" },
        poster,
      );

      await waitFor(() => !executorTesting.runningProcesses.has("w6"));
      expect(executorTesting.runningProcesses.has("w6")).toBe(false);
      expect(posts().length).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test("posts an error result when PowerShell is missing, with no shell fallback", async () => {
    const { poster, posts } = capturingPoster();
    const missing = createWindowsHostBashExecutor(
      "vellum-missing-powershell.exe",
    );

    missing.handleRequest(
      {
        type: "host_bash_request",
        requestId: "w7",
        command: "Write-Output hi",
      },
      poster,
    );

    await waitFor(() => posts().length > 0, 5_000);

    expect(posts().length).toBe(1);
    expect(posts()[0].body.exitCode).toBe(1);
    expect(posts()[0].body.timedOut).toBe(false);
    expect(posts()[0].body.stderr as string).toMatch(/ENOENT|not found/i);
  });
});
