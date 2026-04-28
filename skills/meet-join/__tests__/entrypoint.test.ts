/**
 * Tests for `skills/meet-join/entrypoint.ts`.
 *
 * The entrypoint is the long-lived bin the daemon's `MeetHostSupervisor`
 * spawns via `bun run skills/meet-join/entrypoint.ts`. It owns the
 * `SkillHostClient` connection lifecycle, drives the skill's
 * `register(host)` once connected, then keeps the socket alive until the
 * daemon disconnects or sends `skill.shutdown` (or the OS signals us).
 *
 * What we test here:
 *
 *   1. `parseEntrypointArgs` — the CLI surface the supervisor depends on.
 *      Missing `--ipc` must fail loudly; `--skill-id` must default to
 *      `meet-join`.
 *
 *   2. `runEntrypoint` against a stand-in IPC server that mimics the
 *      protocol shape `SkillIpcServer` exposes (newline-delimited JSON,
 *      `host.identity.*` / `host.platform.*` bootstrap responses, and
 *      observation of `host.registries.register_tools` calls).
 *
 *      We mock the skill-internal session-manager and route-handler
 *      modules so `register()` doesn't drag the real Docker / HTTP
 *      transitives into the test. Mocks live entirely under
 *      `skills/meet-join/` so the PR 19 guard (forbidding `assistant/`
 *      references from `skills/` test files) stays green.
 *
 *      The test exercises the full bootstrap-to-shutdown flow:
 *        - open client connection
 *        - observe `register_tools` reaching the server
 *        - send a daemon-initiated `skill.shutdown` request
 *        - assert `runEntrypoint` resolves with exit code 0
 *
 * Production parity: this is an integration test against the same
 * `SkillHostClient` the deployed bin uses, so a regression in
 * `register_tools` ordering, the sync-state prefetch, or the daemon→skill
 * dispatch protocol would break this test before it broke the live
 * supervisor.
 */

import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the meet-internal route handler so register() doesn't pull in the
// HTTP transitives. The pattern regex is the only field register.ts
// reads at registration time.
mock.module("../routes/meet-internal.js", () => ({
  MEET_INTERNAL_EVENTS_PATH_RE: /^\/v1\/internal\/meet\/([^/]+)\/events$/,
  handleMeetInternalEvents: async () => new Response(null, { status: 204 }),
}));

// Stub the session manager so register() can construct it without
// touching Docker / SQLite. The real factory pulls in heavy module
// graphs; the stub is enough because register.ts only takes the return
// value to pass into module-level singleton wiring elsewhere.
mock.module("../daemon/session-manager.js", () => ({
  createMeetSessionManager: () => ({
    activeSessions: () => [],
    getSession: () => null,
  }),
  MeetSessionManager: {
    activeSessions: () => [],
    getSession: () => null,
  },
}));

// Stub each tool factory so we don't pay the schema-build cost in tests
// that don't care about tool definitions. Each factory must return an
// object that satisfies the `Tool` shape `register.ts` constructs.
const fakeTool = (name: string) => ({
  name,
  description: "test fake",
  category: "fake",
  defaultRiskLevel: "low",
  ownerSkillId: "meet-join",
  ownerSkillBundled: true,
  ownerSkillVersionHash: "test",
  executionTarget: "host" as const,
  executionMode: "proxy" as const,
  getDefinition: () => ({ name, description: "test fake", input_schema: {} }),
  execute: async () => ({ ok: true }),
});

mock.module("../tools/meet-avatar-tool.js", () => ({
  createMeetEnableAvatarTool: () => fakeTool("meet_enable_avatar"),
  createMeetDisableAvatarTool: () => fakeTool("meet_disable_avatar"),
}));
mock.module("../tools/meet-join-tool.js", () => ({
  createMeetJoinTool: () => fakeTool("meet_join"),
  MEET_FLAG_KEY: "meet",
}));
mock.module("../tools/meet-leave-tool.js", () => ({
  createMeetLeaveTool: () => fakeTool("meet_leave"),
}));
mock.module("../tools/meet-send-chat-tool.js", () => ({
  createMeetSendChatTool: () => fakeTool("meet_send_chat"),
}));
mock.module("../tools/meet-speak-tool.js", () => ({
  createMeetSpeakTool: () => fakeTool("meet_speak"),
  createMeetCancelSpeakTool: () => fakeTool("meet_cancel_speak"),
}));

// Pulled after mocks so the import resolves the stubbed module graph.
const { parseEntrypointArgs, runEntrypoint } = await import("../entrypoint.js");

// ---------------------------------------------------------------------------
// Stand-in IPC server
// ---------------------------------------------------------------------------

type IpcRequest = { id: string; method: string; params?: unknown };

interface StubServer {
  server: Server;
  observed: IpcRequest[];
  /** Push a daemon-initiated request frame to the connected skill. */
  sendDaemonRequest: (method: string, params?: unknown) => Promise<unknown>;
  stop: () => Promise<void>;
}

/**
 * Spin up a Unix-domain server that speaks the same JSON-lines protocol
 * as `SkillIpcServer`. Responds to the bootstrap RPCs the client issues
 * during `connect()` and records every other request for assertions.
 */
async function startStubServer(socketPath: string): Promise<StubServer> {
  const observed: IpcRequest[] = [];
  let connectedSocket: Socket | null = null;
  let nextDaemonId = 1;
  const pendingDaemonResponses = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  const server = createServer((socket) => {
    connectedSocket = socket;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let frame: IpcRequest & { result?: unknown; error?: string };
        try {
          frame = JSON.parse(line) as IpcRequest & {
            result?: unknown;
            error?: string;
          };
        } catch {
          continue;
        }

        // Response frame for a daemon-initiated request.
        if (frame.id.startsWith("d:") && frame.method === undefined) {
          const pending = pendingDaemonResponses.get(frame.id);
          if (pending) {
            pendingDaemonResponses.delete(frame.id);
            if (frame.error !== undefined) {
              pending.reject(new Error(String(frame.error)));
            } else {
              pending.resolve(frame.result);
            }
          }
          continue;
        }

        observed.push(frame);

        // Bootstrap responses the client awaits during `connect()`.
        let result: unknown;
        switch (frame.method) {
          case "host.identity.getAssistantName":
            result = null;
            break;
          case "host.platform.workspaceDir":
            result = "/tmp/test-workspace";
            break;
          case "host.platform.vellumRoot":
            result = "/tmp/test-vellum";
            break;
          case "host.platform.runtimeMode":
            result = "bare-metal";
            break;
          case "host.log":
            result = { ok: true };
            break;
          case "host.registries.register_tools":
          case "host.registries.register_skill_route":
          case "host.registries.register_shutdown_hook":
            result = { ok: true };
            break;
          default:
            result = null;
        }
        socket.write(JSON.stringify({ id: frame.id, result }) + "\n");
      }
    });
    socket.on("error", () => {
      /* ignore */
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    observed,
    sendDaemonRequest: (method, params) =>
      new Promise<unknown>((resolve, reject) => {
        if (!connectedSocket || connectedSocket.destroyed) {
          reject(new Error("StubServer: no client connected"));
          return;
        }
        const id = `d:${nextDaemonId++}`;
        pendingDaemonResponses.set(id, { resolve, reject });
        const frame: { id: string; method: string; params?: unknown } = {
          id,
          method,
        };
        if (params !== undefined) frame.params = params;
        connectedSocket.write(JSON.stringify(frame) + "\n");
      }),
    stop: async () => {
      if (connectedSocket && !connectedSocket.destroyed) {
        connectedSocket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseEntrypointArgs", () => {
  test("parses --ipc and defaults --skill-id to meet-join", () => {
    expect(parseEntrypointArgs(["--ipc=/tmp/foo.sock"])).toEqual({
      socketPath: "/tmp/foo.sock",
      skillId: "meet-join",
    });
  });

  test("respects an explicit --skill-id override", () => {
    expect(
      parseEntrypointArgs(["--ipc=/tmp/foo.sock", "--skill-id=other"]),
    ).toEqual({
      socketPath: "/tmp/foo.sock",
      skillId: "other",
    });
  });

  test("throws when --ipc is missing", () => {
    expect(() => parseEntrypointArgs([])).toThrow(/--ipc=<socket-path>/);
  });
});

describe("runEntrypoint", () => {
  let tempDir = "";
  let socketPath = "";
  let stub: StubServer | null = null;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "meet-host-entrypoint-"));
    socketPath = join(tempDir, "assistant-skill.sock");
    stub = await startStubServer(socketPath);
  });

  afterEach(async () => {
    await stub?.stop();
    stub = null;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("connects, drives register(), and exits 0 on skill.shutdown", async () => {
    const exitPromise = runEntrypoint({
      socketPath,
      skillId: "meet-join",
    });

    // Give register() a moment to run and emit IPC frames. The client's
    // sync-state bootstrap fires five RPCs before we observe anything
    // skill-side, so wait for register_tools to land.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (
        stub!.observed.some(
          (f) => f.method === "host.registries.register_tools",
        )
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    // register_tools must have been called — that's the readiness
    // signal the supervisor watches for. Tools may be empty here
    // because the client's sync `host.config.isFeatureFlagEnabled`
    // throws (the contract requires async feature-flag reads over
    // IPC), and register.ts catches that and returns []. The frame
    // arriving at all is what proves the entrypoint is alive.
    const registerTools = stub!.observed.find(
      (f) => f.method === "host.registries.register_tools",
    );
    expect(registerTools).toBeTruthy();

    // The skill route registration is unconditional in register.ts.
    expect(
      stub!.observed.some(
        (f) => f.method === "host.registries.register_skill_route",
      ),
    ).toBe(true);

    // Send a daemon-initiated `skill.shutdown` request. The entrypoint's
    // installed handler resolves the exit trigger; runEntrypoint should
    // return 0 once teardown completes. The handler returns no value,
    // which the client wraps as a successful response with `result: null`.
    await stub!.sendDaemonRequest("skill.shutdown");

    const code = await exitPromise;
    expect(code).toBe(0);
  }, 10_000);

  test("exits 1 when the socket path doesn't exist", async () => {
    const code = await runEntrypoint({
      socketPath: join(tempDir, "does-not-exist.sock"),
      skillId: "meet-join",
    });
    expect(code).toBe(1);
  }, 10_000);
});
