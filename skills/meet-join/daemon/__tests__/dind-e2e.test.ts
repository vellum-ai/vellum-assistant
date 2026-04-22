/**
 * Phase 1.10 (DinD) E2E coverage that's complementary to
 * `docker-mode-e2e.test.ts`. That file already exercises the happy-path
 * spawn-arg shape, the bare-metal regression, and the bogus-socket
 * preflight failure. This file focuses on assertions specific to the DinD
 * model that the existing file does NOT cover:
 *
 *   1. Preflight `/_ping` failure with a *responsive* mock server (the
 *      socket is reachable; dockerd just returns 5xx). Distinguishes the
 *      "socket path doesn't exist" case from the "socket exists but
 *      dockerd is broken" case, and proves that no `/containers/create`
 *      request leaks past the failed probe.
 *   2. Daemon-localhost port-binding contract — the `127.0.0.1:0` shape on
 *      `/containers/create` is a bind on the *daemon container's*
 *      localhost (NOT the host's), and the ephemeral port the daemon
 *      reports back via `/containers/<id>/json` is propagated end-to-end
 *      into the session record (so the daemon's HTTP client can dial
 *      bot:127.0.0.1:<port> from inside the same container).
 *   3. Explicit `Mounts` payload absence — assert there is *no* key named
 *      `Mounts` on `HostConfig` at all (the existing test asserts the
 *      parsed value is `undefined`, which would also pass if the value
 *      were the literal `null` or an empty array — the byte-level absence
 *      is the actual contract).
 *   4. Bare-metal regression on the DinD-specific surfaces only — that
 *      no preflight `/_ping` is issued and no `Mounts` key is present.
 *
 * Pure mock-based; no real Docker, no real Meet.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import {
  DockerRunner,
  dockerSocketUnreachableMessage,
  resetSocketReachabilityCacheForTests,
} from "../docker-runner.js";
import { meetEventDispatcher } from "../event-publisher.js";
import { __resetMeetSessionEventRouterForTests } from "../session-event-router.js";
import {
  _createMeetSessionManagerForTests,
  MEET_BOT_INTERNAL_PORT,
  type MeetAudioIngestLike,
  type MeetConsentMonitorLike,
  type MeetConversationBridgeLike,
  type MeetStorageWriterLike,
} from "../session-manager.js";

// ---------------------------------------------------------------------------
// Mock Docker Engine — same pattern as docker-mode-e2e.test.ts: a real HTTP
// server bound to a tempdir unix socket. The DockerRunner exercises its
// `http.request({ socketPath })` codepath end-to-end.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

interface QueuedResponse {
  status: number;
  body: string | object | null;
}

interface DockerEngineMock {
  socketPath: string;
  captured: CapturedRequest[];
  queueResponse(res: QueuedResponse): void;
  close(): Promise<void>;
}

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dind-e2e-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function startDockerEngineMock(): Promise<DockerEngineMock> {
  const captured: CapturedRequest[] = [];
  const queue: QueuedResponse[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const queued = queue.shift() ?? {
        status: 500,
        body: "no response queued",
      };
      const serialized =
        queued.body === null
          ? ""
          : typeof queued.body === "string"
            ? queued.body
            : JSON.stringify(queued.body);
      res.writeHead(queued.status, {
        "Content-Type":
          typeof queued.body === "object" && queued.body !== null
            ? "application/json"
            : "text/plain",
      });
      res.end(serialized);
    });
  });

  // macOS caps unix socket paths around 104 bytes; keep it short.
  const socketPath = join(
    tempDir,
    `e2e-${Math.random().toString(36).slice(2)}.sock`,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    socketPath,
    captured,
    queueResponse: (r) => queue.push(r),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// No-op subsystem stubs (same shape as docker-mode-e2e.test.ts so the
// session-manager can complete `join()` without dragging the real
// transcription / storage / consent paths into the test).
// ---------------------------------------------------------------------------

function makeFakeAudioIngest(): MeetAudioIngestLike {
  const subscribers = new Set<(bytes: Uint8Array) => void>();
  return {
    start: mock(async () => ({ port: 42173, ready: Promise.resolve() })),
    stop: mock(async () => {}),
    subscribePcm: mock((cb: (bytes: Uint8Array) => void) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    }),
  };
}

function makeFakeConsentMonitor(): MeetConsentMonitorLike {
  return { start: mock(() => {}), stop: mock(() => {}) };
}

function makeFakeConversationBridge(): MeetConversationBridgeLike {
  return { subscribe: mock(() => {}), unsubscribe: mock(() => {}) };
}

function makeFakeStorageWriter(): MeetStorageWriterLike {
  return {
    start: mock(() => {}),
    startAudio: mock(async () => {}),
    stop: mock(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findCreateRequest(
  captured: CapturedRequest[],
): CapturedRequest | undefined {
  return captured.find(
    (c) => c.method === "POST" && c.url.includes("/containers/create"),
  );
}

function findPingRequests(captured: CapturedRequest[]): CapturedRequest[] {
  return captured.filter((c) => c.url.includes("/_ping"));
}

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let workspaceDir: string;
let engine: DockerEngineMock | null;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "dind-e2e-ws-"));
  __resetMeetSessionEventRouterForTests();
  meetEventDispatcher._resetForTests();
  // The `/_ping` cache is module-scoped; tempdir sockets are unique so
  // cross-test pollution shouldn't happen, but reset defensively.
  resetSocketReachabilityCacheForTests();
  engine = null;
});

afterEach(async () => {
  if (engine) {
    await engine.close();
    engine = null;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
  __resetMeetSessionEventRouterForTests();
  meetEventDispatcher._resetForTests();
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("Meet DinD E2E (net-new coverage vs. docker-mode-e2e.test.ts)", () => {
  test("docker mode: /_ping returns 5xx → join() rejects with the Phase 1.10 prerequisite-missing error and NO /containers/create is issued", async () => {
    engine = await startDockerEngineMock();
    // The socket exists and is responsive at the TCP level — but dockerd
    // is broken: ping returns 500. This is the "init supervisor started
    // dockerd, then dockerd crashed mid-boot" failure mode and is
    // distinct from the bogus-socket case the sister file covers.
    engine.queueResponse({ status: 500, body: "dockerd internal error" });

    const runner = new DockerRunner({
      socketPath: engine.socketPath,
      resolveMode: () => "docker",
      workspaceDir,
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "tts-k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: makeFakeAudioIngest,
      consentMonitorFactory: makeFakeConsentMonitor,
      conversationBridgeFactory: makeFakeConversationBridge,
      storageWriterFactory: makeFakeStorageWriter,
      resolveAssistantDisplayName: () => "Atlas",
    });

    await expect(
      manager.join({
        url: "https://meet.google.com/ping-fail-aaa",
        meetingId: "m-ping-fail",
        conversationId: "conv-ping-fail",
      }),
    ).rejects.toThrow(dockerSocketUnreachableMessage(engine.socketPath));

    // Exactly one request was made — the failed ping. No create leaked.
    expect(findPingRequests(engine.captured)).toHaveLength(1);
    expect(findCreateRequest(engine.captured)).toBeUndefined();
    expect(manager.activeSessions()).toHaveLength(0);
  });

  test("docker mode: published port shape is daemon-localhost (127.0.0.1:0 on create) and the ephemeral port from inspect is propagated end-to-end", async () => {
    engine = await startDockerEngineMock();
    const ephemeralHostPort = "51823";
    // /_ping → /containers/create → /containers/<id>/start → /containers/<id>/json
    engine.queueResponse({ status: 200, body: "OK" });
    engine.queueResponse({ status: 201, body: { Id: "dk-port" } });
    engine.queueResponse({ status: 204, body: null });
    engine.queueResponse({
      status: 200,
      body: {
        Id: "dk-port",
        NetworkSettings: {
          Ports: {
            [`${MEET_BOT_INTERNAL_PORT}/tcp`]: [
              { HostIp: "127.0.0.1", HostPort: ephemeralHostPort },
            ],
          },
        },
      },
    });

    const runner = new DockerRunner({
      socketPath: engine.socketPath,
      resolveMode: () => "docker",
      workspaceDir,
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "tts-k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      resolveDaemonUrl: () => "http://host.docker.internal:7821",
      audioIngestFactory: makeFakeAudioIngest,
      consentMonitorFactory: makeFakeConsentMonitor,
      conversationBridgeFactory: makeFakeConversationBridge,
      storageWriterFactory: makeFakeStorageWriter,
      resolveAssistantDisplayName: () => "Atlas",
    });

    const session = await manager.join({
      url: "https://meet.google.com/port-shape-aaa",
      meetingId: "m-port",
      conversationId: "conv-port",
    });

    try {
      const createReq = findCreateRequest(engine.captured)!;
      const body = JSON.parse(createReq.body) as {
        HostConfig: {
          PortBindings: Record<
            string,
            Array<{ HostIp: string; HostPort: string }>
          >;
        };
      };

      // The bind requested at create-time is on the *daemon container's*
      // 127.0.0.1, not the host's — DinD bot containers are siblings on
      // the inner Docker bridge, and the daemon dials them via its own
      // localhost. Crucially, this is NOT `0.0.0.0` (which would publish
      // on every interface and is the wrong contract for DinD where the
      // bot is reachable only from within the daemon container) and is
      // NOT a fixed port (collisions across concurrent meetings would be
      // immediate).
      const portKey = `${MEET_BOT_INTERNAL_PORT}/tcp`;
      const bindings = body.HostConfig.PortBindings[portKey];
      expect(bindings).toEqual([{ HostIp: "127.0.0.1", HostPort: "0" }]);
      expect(bindings[0].HostIp).not.toBe("0.0.0.0");
      expect(bindings[0].HostIp).not.toBe("");

      // The ephemeral port the daemon picks comes back via inspect and
      // must be propagated into the session record so the daemon's HTTP
      // client can dial bot:127.0.0.1:<that port>. This is the
      // end-to-end proof that the DinD plumbing carries the
      // daemon-localhost contract all the way from create → inspect →
      // session.
      expect(session.botBaseUrl).toBe(`http://127.0.0.1:${ephemeralHostPort}`);
    } finally {
      await manager.leave("m-port", "test-cleanup");
    }
  });

  test("docker mode: /containers/create body has NO Mounts key whatsoever (byte-level absence, not just undefined)", async () => {
    engine = await startDockerEngineMock();
    engine.queueResponse({ status: 200, body: "OK" });
    engine.queueResponse({ status: 201, body: { Id: "dk-mounts" } });
    engine.queueResponse({ status: 204, body: null });
    engine.queueResponse({
      status: 200,
      body: {
        Id: "dk-mounts",
        NetworkSettings: {
          Ports: {
            [`${MEET_BOT_INTERNAL_PORT}/tcp`]: [
              { HostIp: "127.0.0.1", HostPort: "49270" },
            ],
          },
        },
      },
    });

    const runner = new DockerRunner({
      socketPath: engine.socketPath,
      resolveMode: () => "docker",
      workspaceDir,
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "tts-k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: makeFakeAudioIngest,
      consentMonitorFactory: makeFakeConsentMonitor,
      conversationBridgeFactory: makeFakeConversationBridge,
      storageWriterFactory: makeFakeStorageWriter,
      resolveAssistantDisplayName: () => "Atlas",
    });

    const session = await manager.join({
      url: "https://meet.google.com/no-mounts-aaa",
      meetingId: "m-no-mounts",
      conversationId: "conv-no-mounts",
    });

    try {
      const createReq = findCreateRequest(engine.captured)!;

      // Inspect the raw bytes — `JSON.parse(...).HostConfig.Mounts ===
      // undefined` would also be true if the wire body had `"Mounts":
      // null` or `"Mounts": []`, neither of which is what the Phase 1.10
      // contract specifies. Docker treats `"Mounts": []` semantically
      // identically to "no mounts", but we want belt-and-suspenders that
      // the legacy named-volume mount path is *truly gone* from the
      // wire, not just emptied.
      expect(createReq.body).not.toContain('"Mounts"');
      expect(createReq.body).not.toContain('"Type":"volume"');
      expect(createReq.body).not.toContain('"VolumeOptions"');

      // Sanity: the parsed shape is what we expect.
      const parsed = JSON.parse(createReq.body) as {
        HostConfig: Record<string, unknown>;
      };
      expect("Mounts" in parsed.HostConfig).toBe(false);
    } finally {
      await manager.leave("m-no-mounts", "test-cleanup");
    }
  });

  test("bare-metal regression: no /_ping is issued and no Mounts key appears on /containers/create", async () => {
    engine = await startDockerEngineMock();
    // Bare-metal skips /_ping. create → start → inspect.
    engine.queueResponse({ status: 201, body: { Id: "bm-2" } });
    engine.queueResponse({ status: 204, body: null });
    engine.queueResponse({
      status: 200,
      body: {
        Id: "bm-2",
        NetworkSettings: {
          Ports: {
            [`${MEET_BOT_INTERNAL_PORT}/tcp`]: [
              { HostIp: "127.0.0.1", HostPort: "49280" },
            ],
          },
        },
      },
    });

    const runner = new DockerRunner({
      socketPath: engine.socketPath,
      resolveMode: () => "bare-metal",
      workspaceDir,
    });

    const manager = _createMeetSessionManagerForTests({
      dockerRunnerFactory: () => runner,
      getProviderKey: async () => "tts-k",
      getWorkspaceDir: () => workspaceDir,
      botLeaveFetch: async () => {},
      audioIngestFactory: makeFakeAudioIngest,
      consentMonitorFactory: makeFakeConsentMonitor,
      conversationBridgeFactory: makeFakeConversationBridge,
      storageWriterFactory: makeFakeStorageWriter,
      resolveAssistantDisplayName: () => "Atlas",
    });

    const session = await manager.join({
      url: "https://meet.google.com/bm-regression-aaa",
      meetingId: "m-bm-2",
      conversationId: "conv-bm-2",
    });

    try {
      // Phase 1.8 invariant: bare-metal never pings; the ping cost is
      // pure tax in the local-developer case where Docker may simply not
      // be running and the create-failure path already produces a clear
      // error.
      expect(findPingRequests(engine.captured)).toHaveLength(0);

      // Phase 1.10 invariant: bare-metal also uses simple binds, never
      // the named-volume Mounts payload (PR 5 deletes the helper
      // entirely). Same byte-level assertion as the Docker-mode test
      // above.
      const createReq = findCreateRequest(engine.captured)!;
      expect(createReq.body).not.toContain('"Mounts"');
      expect(createReq.body).not.toContain('"Type":"volume"');
    } finally {
      await manager.leave("m-bm-2", "test-cleanup");
    }
  });
});
