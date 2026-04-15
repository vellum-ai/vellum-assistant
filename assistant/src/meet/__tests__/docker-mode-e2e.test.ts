/**
 * End-to-end Docker-mode spawn-arg regression test for the Meet pipeline.
 *
 * What this test covers:
 *   - Bare-metal mode: `DockerRunner.resolveMounts` emits host-path `Binds`
 *     instead of named-volume `Mounts`, and does not reference the workspace
 *     volume name.
 *   - Docker mode: `DockerRunner.resolveMounts` emits `HostConfig.Mounts`
 *     with `VolumeOptions.Subpath` referencing the injected workspace volume
 *     name, the `ExtraHosts` entry for `host.docker.internal:host-gateway`
 *     is always present, the daemon URL uses `host.docker.internal`, the
 *     internal bot port is published on `127.0.0.1:<ephemeral>`, and the env
 *     vars the bot requires (`DAEMON_URL`, `MEETING_ID`, `MEET_URL`,
 *     `JOIN_NAME`, `BOT_API_TOKEN`, `CONSENT_MESSAGE`) are present.
 *   - Docker mode with no workspace volume: `join()` surfaces the
 *     prerequisite-missing error before any `/containers/create` is issued
 *     (only the memoized `/_ping` round-trip happens).
 *   - Docker mode with unreachable socket: `join()` surfaces the
 *     socket-unreachable prerequisite-missing error from the ping probe
 *     before any create/start is issued.
 *
 * Nothing here touches a real Docker daemon or a real Meet URL. The
 * DockerRunner talks to an in-process HTTP server bound to a tempdir unix
 * socket, mirroring the pattern used by `docker-runner.test.ts`. Other
 * session-manager dependencies (audio ingest, conversation bridge, storage
 * writer, consent monitor) are swapped out for no-op stubs so the assertion
 * surface stays on the spawn-arg shape.
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
  DOCKER_WORKSPACE_VOLUME_MISSING_MESSAGE,
  DockerRunner,
  dockerSocketUnreachableMessage,
  HOST_GATEWAY_ALIAS,
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
// Mock Docker Engine — a real HTTP server bound to a tempdir unix socket.
// Mirrors the pattern in `docker-runner.test.ts` so the runner's native
// `http.request({ socketPath })` path is exercised end-to-end.
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
  tempDir = mkdtempSync(join(tmpdir(), "docker-mode-e2e-"));
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

  // Unix socket paths cap out around 104 bytes on macOS — keep it short.
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
// Minimal no-op subsystem stubs. None of the downstream subscribers are the
// focus of this test; they exist solely so `MeetSessionManager.join()` can
// complete end-to-end without pulling the real conversation bridge, storage
// writer, or consent-monitor LLM path into the test.
// ---------------------------------------------------------------------------

function makeFakeAudioIngest(): MeetAudioIngestLike {
  const subscribers = new Set<(bytes: Uint8Array) => void>();
  return {
    start: mock(async () => {}),
    stop: mock(async () => {}),
    subscribePcm: mock((cb: (bytes: Uint8Array) => void) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    }),
  };
}

function makeFakeConsentMonitor(): MeetConsentMonitorLike {
  return {
    start: mock(() => {}),
    stop: mock(() => {}),
  };
}

function makeFakeConversationBridge(): MeetConversationBridgeLike {
  return {
    subscribe: mock(() => {}),
    unsubscribe: mock(() => {}),
  };
}

function makeFakeStorageWriter(): MeetStorageWriterLike {
  return {
    start: mock(() => {}),
    startAudio: mock(async () => {}),
    stop: mock(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers for parsing captured Docker API requests
// ---------------------------------------------------------------------------

interface DockerCreateBody {
  Image: string;
  Env: string[];
  ExposedPorts: Record<string, Record<string, never>>;
  HostConfig: {
    Binds: string[];
    PortBindings: Record<
      string,
      Array<{ HostIp: string; HostPort: string }>
    >;
    ExtraHosts: string[];
    NetworkMode?: string;
    Mounts?: Array<{
      Type: "volume";
      Source: string;
      Target: string;
      ReadOnly: boolean;
      VolumeOptions: { Subpath: string };
    }>;
  };
}

function envToMap(env: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of env) {
    const idx = entry.indexOf("=");
    if (idx < 0) continue;
    out[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return out;
}

function findCreateRequest(
  captured: CapturedRequest[],
): CapturedRequest | undefined {
  return captured.find(
    (c) => c.method === "POST" && c.url.includes("/containers/create"),
  );
}

// ---------------------------------------------------------------------------
// Shared per-test state
// ---------------------------------------------------------------------------

let workspaceDir: string;
let engine: DockerEngineMock | null;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "docker-mode-e2e-ws-"));
  __resetMeetSessionEventRouterForTests();
  meetEventDispatcher._resetForTests();
  // The `/_ping` reachability cache is module-scoped so it survives
  // per-test teardown; tempdir socket paths are unique so cross-test
  // pollution is unlikely, but we reset defensively to keep assertions on
  // call counts deterministic.
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

describe("Meet Docker-mode spawn-arg E2E", () => {
  test("docker mode: uses named-volume subpath mounts, host-gateway alias, host.docker.internal DAEMON_URL, and ephemeral 127.0.0.1 port binding", async () => {
    engine = await startDockerEngineMock();
    // /_ping → /containers/create → /containers/<id>/start → /containers/<id>/json
    engine.queueResponse({ status: 200, body: "OK" });
    engine.queueResponse({ status: 201, body: { Id: "dk-1" } });
    engine.queueResponse({ status: 204, body: null });
    engine.queueResponse({
      status: 200,
      body: {
        Id: "dk-1",
        NetworkSettings: {
          Ports: {
            [`${MEET_BOT_INTERNAL_PORT}/tcp`]: [
              { HostIp: "127.0.0.1", HostPort: "49250" },
            ],
          },
        },
      },
    });

    const runner = new DockerRunner({
      socketPath: engine.socketPath,
      resolveMode: () => "docker",
      resolveWorkspaceVolumeName: async () => "test-workspace-vol",
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
      url: "https://meet.google.com/abc-defg-hij",
      meetingId: "m-docker-1",
      conversationId: "conv-docker-1",
    });

    try {
      expect(session.containerId).toBe("dk-1");

      const createReq = findCreateRequest(engine.captured);
      expect(createReq).toBeDefined();
      // Container name is encoded in the query string.
      expect(createReq!.url).toContain("name=vellum-meet-m-docker-1");

      const body = JSON.parse(createReq!.body) as DockerCreateBody;

      // ── Subpath volume mounts referencing the injected volume name ──
      expect(body.HostConfig.Binds).toEqual([]);
      expect(body.HostConfig.Mounts).toEqual([
        {
          Type: "volume",
          Source: "test-workspace-vol",
          Target: "/sockets",
          ReadOnly: false,
          VolumeOptions: { Subpath: "meets/m-docker-1/sockets" },
        },
        {
          Type: "volume",
          Source: "test-workspace-vol",
          Target: "/out",
          ReadOnly: false,
          VolumeOptions: { Subpath: "meets/m-docker-1/out" },
        },
      ]);

      // ── host-gateway alias is always emitted ──
      expect(body.HostConfig.ExtraHosts).toEqual([HOST_GATEWAY_ALIAS]);

      // ── Ephemeral 127.0.0.1 port binding on the bot's internal port ──
      const portKey = `${MEET_BOT_INTERNAL_PORT}/tcp`;
      expect(body.ExposedPorts[portKey]).toEqual({});
      expect(body.HostConfig.PortBindings[portKey]).toEqual([
        { HostIp: "127.0.0.1", HostPort: "0" },
      ]);

      // ── Env vars expected by the meet-bot ──
      const env = envToMap(body.Env);
      expect(env.DAEMON_URL).toBe("http://host.docker.internal:7821");
      expect(env.DAEMON_URL.startsWith("http://host.docker.internal:")).toBe(
        true,
      );
      expect(env.DAEMON_URL).not.toContain("127.0.0.1");
      expect(env.DAEMON_URL).not.toContain("localhost");
      expect(env.MEETING_ID).toBe("m-docker-1");
      expect(env.MEET_URL).toBe("https://meet.google.com/abc-defg-hij");
      expect(env.JOIN_NAME).toBe("Atlas");
      expect(env.BOT_API_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      expect(env.CONSENT_MESSAGE.length).toBeGreaterThan(0);
      expect(env.CONSENT_MESSAGE).not.toContain("{assistantName}");
      expect(env.CONSENT_MESSAGE).toContain("Atlas");
      expect(env.TTS_API_KEY).toBe("tts-k");
      expect(env.SKIP_PULSE).toBe("0");

      // ── Bot network (from config default) ──
      expect(body.HostConfig.NetworkMode).toBe("bridge");

      // Confirm the Docker API saw a ping before create.
      expect(engine.captured[0].method).toBe("GET");
      expect(engine.captured[0].url).toContain("/_ping");
    } finally {
      await manager.leave("m-docker-1", "test-cleanup");
    }
  });

  test("bare-metal mode: uses host-path Binds, no named-volume Mounts, and does not reference the volume name", async () => {
    engine = await startDockerEngineMock();
    // Bare-metal skips /_ping. create → start → inspect.
    engine.queueResponse({ status: 201, body: { Id: "bm-1" } });
    engine.queueResponse({ status: 204, body: null });
    engine.queueResponse({
      status: 200,
      body: {
        Id: "bm-1",
        NetworkSettings: {
          Ports: {
            [`${MEET_BOT_INTERNAL_PORT}/tcp`]: [
              { HostIp: "127.0.0.1", HostPort: "49260" },
            ],
          },
        },
      },
    });

    // Resolver should never be consulted in bare-metal mode — surface a
    // clear failure if that invariant ever regresses.
    const resolveWorkspaceVolumeNameSpy = mock(async () => {
      throw new Error(
        "resolveWorkspaceVolumeName must not be called in bare-metal mode",
      );
    });

    const runner = new DockerRunner({
      socketPath: engine.socketPath,
      resolveMode: () => "bare-metal",
      resolveWorkspaceVolumeName: resolveWorkspaceVolumeNameSpy,
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
      url: "https://meet.google.com/aaa-bbbb-ccc",
      meetingId: "m-bm-1",
      conversationId: "conv-bm-1",
    });

    try {
      expect(session.containerId).toBe("bm-1");

      const createReq = findCreateRequest(engine.captured);
      expect(createReq).toBeDefined();
      const body = JSON.parse(createReq!.body) as DockerCreateBody;

      // ── Host-path binds rooted in the workspace dir ──
      expect(body.HostConfig.Binds).toEqual([
        `${workspaceDir}/meets/m-bm-1/sockets:/sockets`,
        `${workspaceDir}/meets/m-bm-1/out:/out`,
      ]);

      // ── No Mounts payload at all — purely bind-mount path ──
      expect(body.HostConfig.Mounts).toBeUndefined();

      // ── And no reference to the Docker-mode volume name ──
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("test-workspace-vol");

      // ── host-gateway alias is still emitted unconditionally ──
      expect(body.HostConfig.ExtraHosts).toEqual([HOST_GATEWAY_ALIAS]);

      // ── Resolver must not be consulted in bare-metal mode ──
      expect(resolveWorkspaceVolumeNameSpy).toHaveBeenCalledTimes(0);

      // ── /_ping is skipped in bare-metal mode — only create + start + inspect ──
      expect(engine.captured).toHaveLength(3);
      expect(
        engine.captured.find((c) => c.url.includes("/_ping")),
      ).toBeUndefined();
    } finally {
      await manager.leave("m-bm-1", "test-cleanup");
    }
  });

  test("docker mode: missing workspace volume surfaces the prerequisite-missing error before any create is issued", async () => {
    engine = await startDockerEngineMock();
    // Only /_ping should be consumed — the runner bails on the volume lookup
    // before reaching /containers/create.
    engine.queueResponse({ status: 200, body: "OK" });

    const runner = new DockerRunner({
      socketPath: engine.socketPath,
      resolveMode: () => "docker",
      resolveWorkspaceVolumeName: async () => null,
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
        url: "https://meet.google.com/xxx-yyyy-zzz",
        meetingId: "m-no-vol",
        conversationId: "conv-no-vol",
      }),
    ).rejects.toThrow(DOCKER_WORKSPACE_VOLUME_MISSING_MESSAGE);

    // Only the memoized /_ping round-trip happened — no create/start.
    expect(engine.captured).toHaveLength(1);
    expect(engine.captured[0].url).toContain("/_ping");
    expect(
      engine.captured.find((c) => c.url.includes("/containers/create")),
    ).toBeUndefined();
    expect(
      engine.captured.find((c) => c.url.includes("/start")),
    ).toBeUndefined();

    // No session lingers on the error path.
    expect(manager.activeSessions()).toHaveLength(0);
  });

  test("docker mode: unreachable docker socket surfaces the prerequisite-missing error before any create is issued", async () => {
    // No mock server — point at a socket path that nobody is listening on so
    // the /_ping probe fails fast. This parallels the DockerRunner unit test
    // but covers the full session-manager → docker-runner pipe.
    const bogusSocketPath = join(tempDir, "nonexistent.sock");

    const runner = new DockerRunner({
      socketPath: bogusSocketPath,
      resolveMode: () => "docker",
      // Volume name resolver should never be consulted — we bail at ping.
      resolveWorkspaceVolumeName: async () => {
        throw new Error(
          "resolveWorkspaceVolumeName must not be called when the socket is unreachable",
        );
      },
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
        url: "https://meet.google.com/aaa-bbbb-ccc",
        meetingId: "m-no-sock",
        conversationId: "conv-no-sock",
      }),
    ).rejects.toThrow(dockerSocketUnreachableMessage(bogusSocketPath));

    // No session lingers on the error path.
    expect(manager.activeSessions()).toHaveLength(0);
  });
});
