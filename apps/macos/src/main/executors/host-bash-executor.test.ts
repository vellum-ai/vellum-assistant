import { afterEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Stubs — must precede executor import
// ---------------------------------------------------------------------------

const MOCK_DEVICE_ID = "test-device-00000000-0000-0000-0000-000000000000";
mock.module("../device-id", () => ({
  getDeviceId: () => MOCK_DEVICE_ID,
  resetDeviceIdCache: () => {},
}));

// Stub electron-log
mock.module("electron-log/main", () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      initialize: noop,
      transports: { file: { maxSize: 0, fileName: "", format: "", getFile: () => ({ path: "" }) } },
    },
  };
});

// Stub lockfile-watcher (required by host-proxy-router)
mock.module("../lockfile-watcher", () => ({
  onLockfileChange: () => () => {},
}));

// Stub @vellumai/local-mode (required by host-proxy-router)
mock.module("@vellumai/local-mode", () => ({
  getGuardianAccessToken: async () => ({ ok: true, accessToken: "test-token" }),
  resolveConfigDir: () => "/tmp/test-config",
}));

const { HostProxyPoster } = await import("../host-proxy-poster");
const { hostBashExecutor, __testing: executorTesting } = await import("./host-bash-executor");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

interface CapturedPost {
  url: string;
  body: Record<string, unknown>;
}

function capturingPoster(): { poster: InstanceType<typeof HostProxyPoster>; posts: () => CapturedPost[] } {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("host-bash-executor", () => {
  afterEach(() => {
    // Clean up any lingering processes
    for (const [, entry] of executorTesting.runningProcesses) {
      try { entry.child.kill("SIGKILL"); } catch { /* already exited */ }
    }
    executorTesting.runningProcesses.clear();
  });

  test("executes a command and posts result", async () => {
    const { poster, posts } = capturingPoster();

    hostBashExecutor.handleRequest(
      { type: "host_bash_request", requestId: "r1", command: "echo hello" },
      poster,
    );

    // Wait for process to complete
    await flush(500);

    expect(posts().length).toBe(1);
    const result = posts()[0].body;
    expect(result.requestId).toBe("r1");
    expect((result.stdout as string).trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("captures stderr output", async () => {
    const { poster, posts } = capturingPoster();

    hostBashExecutor.handleRequest(
      { type: "host_bash_request", requestId: "r2", command: "echo err >&2" },
      poster,
    );

    await flush(500);

    expect(posts().length).toBe(1);
    expect((posts()[0].body.stderr as string).trim()).toBe("err");
  });

  test("reports non-zero exit code", async () => {
    const { poster, posts } = capturingPoster();

    hostBashExecutor.handleRequest(
      { type: "host_bash_request", requestId: "r3", command: "exit 42" },
      poster,
    );

    await flush(500);

    expect(posts().length).toBe(1);
    expect(posts()[0].body.exitCode).toBe(42);
  });

  test("times out and sends SIGTERM then SIGKILL", async () => {
    const { poster, posts } = capturingPoster();

    hostBashExecutor.handleRequest(
      {
        type: "host_bash_request",
        requestId: "r4",
        command: "sleep 60",
        timeout_seconds: 1,
      },
      poster,
    );

    // Wait for timeout + SIGKILL grace period + buffer
    await flush(4_000);

    expect(posts().length).toBe(1);
    expect(posts()[0].body.timedOut).toBe(true);
    expect(posts()[0].body.requestId).toBe("r4");
  });

  test("cancellation terminates process and suppresses result", async () => {
    const { poster, posts } = capturingPoster();

    hostBashExecutor.handleRequest(
      { type: "host_bash_request", requestId: "r5", command: "sleep 60" },
      poster,
    );

    await flush(100);
    expect(executorTesting.runningProcesses.has("r5")).toBe(true);

    hostBashExecutor.handleCancel(
      { type: "host_bash_cancel", requestId: "r5" },
      poster,
    );

    await flush(3_000);

    // Result should be suppressed
    expect(posts().length).toBe(0);
    expect(executorTesting.runningProcesses.has("r5")).toBe(false);
  });

  test("merges environment variables", async () => {
    const { poster, posts } = capturingPoster();

    hostBashExecutor.handleRequest(
      {
        type: "host_bash_request",
        requestId: "r6",
        command: 'echo "$TEST_BASH_VAR"',
        env: { TEST_BASH_VAR: "custom_value" },
      },
      poster,
    );

    await flush(500);

    expect(posts().length).toBe(1);
    expect((posts()[0].body.stdout as string).trim()).toBe("custom_value");
  });

  test("uses specified working directory", async () => {
    const { poster, posts } = capturingPoster();

    hostBashExecutor.handleRequest(
      {
        type: "host_bash_request",
        requestId: "r7",
        command: "pwd",
        working_dir: "/tmp",
      },
      poster,
    );

    await flush(500);

    expect(posts().length).toBe(1);
    // On macOS /tmp is a symlink to /private/tmp
    expect((posts()[0].body.stdout as string).trim()).toMatch(/\/tmp$/);
  });

  test("returns error for missing command", async () => {
    const { poster, posts } = capturingPoster();

    hostBashExecutor.handleRequest(
      { type: "host_bash_request", requestId: "r8" },
      poster,
    );

    await flush(100);

    expect(posts().length).toBe(1);
    expect(posts()[0].body.stderr).toBe("Missing command");
    expect(posts()[0].body.exitCode).toBe(1);
  });
});
