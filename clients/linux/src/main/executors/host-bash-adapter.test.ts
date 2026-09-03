import { afterEach, describe, expect, test } from "bun:test";

import { HostProxyPoster } from "@vellumai/electron-desktop/host-proxy/poster";
import { __testing as executorTesting } from "@vellumai/electron-desktop/host-proxy/executors/host-shell-executor";

import { createLinuxHostBashExecutor } from "./host-bash-adapter";

const executor = createLinuxHostBashExecutor();

async function waitFor(
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

function capturingPoster(): {
  poster: InstanceType<typeof HostProxyPoster>;
  posts: () => Array<{ url: string; body: Record<string, unknown> }>;
} {
  const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
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

describe("linux host-bash adapter", () => {
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

  test("runs a bash command and posts the result", async () => {
    const { poster, posts } = capturingPoster();
    executor.handleRequest(
      {
        type: "host_bash_request",
        requestId: "req-1",
        command: "printf hello",
      },
      poster,
    );
    await waitFor(() => posts().length > 0);
    expect(posts().length).toBe(1);
    expect(posts()[0]?.body).toMatchObject({
      requestId: "req-1",
      stdout: "hello",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
  });
});
