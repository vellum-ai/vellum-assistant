import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import {
  buildCreateBody,
  DOCKER_SOCKET_UNREACHABLE_MESSAGE,
  DOCKER_WORKSPACE_VOLUME_MISSING_MESSAGE,
  DockerApiError,
  DockerRunner,
  extractBoundPorts,
  HOST_GATEWAY_ALIAS,
  resolveWorkspaceSubpath,
} from "../docker-runner.js";

// ---------------------------------------------------------------------------
// Mock Docker Engine — a real HTTP server bound to a temporary unix socket
// ---------------------------------------------------------------------------
//
// The runner uses Node's `http.request({ socketPath })`. The cleanest way to
// exercise it is to stand up an actual HTTP server on a unix socket and
// script the responses. This avoids brittle module-level mocking and keeps
// the tests' intent readable.

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

interface QueuedResponse {
  status: number;
  body: string | object | null;
}

interface MockDocker {
  socketPath: string;
  captured: CapturedRequest[];
  queueResponse(res: QueuedResponse): void;
  close(): Promise<void>;
}

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "docker-runner-test-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function startMockDocker(): Promise<MockDocker> {
  const captured: CapturedRequest[] = [];
  const queue: QueuedResponse[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const queued = queue.shift() ?? { status: 500, body: "no response queued" };
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

  // Use a short socket path — unix sockets cap out around 104 bytes on macOS.
  const socketPath = join(tempDir, `docker-${Math.random().toString(36).slice(2)}.sock`);
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
// Tests
// ---------------------------------------------------------------------------

describe("DockerRunner.run", () => {
  let mock: MockDocker;

  afterEach(async () => {
    await mock?.close();
  });

  test("POSTs create body, starts container, returns container id + bound ports", async () => {
    mock = await startMockDocker();

    // /containers/create
    mock.queueResponse({ status: 201, body: { Id: "abc123", Warnings: [] } });
    // /containers/abc123/start
    mock.queueResponse({ status: 204, body: null });
    // /containers/abc123/json
    mock.queueResponse({
      status: 200,
      body: {
        Id: "abc123",
        State: { Running: true, Status: "running", ExitCode: 0 },
        NetworkSettings: {
          Ports: {
            "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49160" }],
          },
        },
      },
    });

    const runner = new DockerRunner({ socketPath: mock.socketPath });
    const result = await runner.run({
      image: "vellum-meet-bot:dev",
      env: { FOO: "bar", BAZ: "qux" },
      binds: [
        { hostPath: "/host/sockets", containerPath: "/sockets" },
        {
          hostPath: "/host/out",
          containerPath: "/out",
          readOnly: true,
        },
      ],
      ports: [
        {
          hostIp: "127.0.0.1",
          hostPort: 0,
          containerPort: 3000,
          protocol: "tcp",
        },
      ],
      name: "vellum-meet-m1",
      network: "bridge",
    });

    expect(result.containerId).toBe("abc123");
    expect(result.boundPorts).toEqual([
      {
        protocol: "tcp",
        containerPort: 3000,
        hostIp: "127.0.0.1",
        hostPort: 49160,
      },
    ]);

    // Verify the request sequence the runner issued.
    expect(mock.captured).toHaveLength(3);

    const [create, start, inspect] = mock.captured;

    expect(create.method).toBe("POST");
    expect(create.url).toContain("/containers/create");
    expect(create.url).toContain("name=vellum-meet-m1");
    const createBody = JSON.parse(create.body);
    expect(createBody.Image).toBe("vellum-meet-bot:dev");
    expect(createBody.Env).toContain("FOO=bar");
    expect(createBody.Env).toContain("BAZ=qux");
    expect(createBody.HostConfig.Binds).toEqual([
      "/host/sockets:/sockets",
      "/host/out:/out:ro",
    ]);
    expect(createBody.HostConfig.PortBindings["3000/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "0" },
    ]);
    expect(createBody.ExposedPorts["3000/tcp"]).toEqual({});
    expect(createBody.HostConfig.NetworkMode).toBe("bridge");

    expect(start.method).toBe("POST");
    expect(start.url).toContain("/containers/abc123/start");

    expect(inspect.method).toBe("GET");
    expect(inspect.url).toContain("/containers/abc123/json");
  });

  test("omits name query param when no name is supplied", async () => {
    mock = await startMockDocker();
    mock.queueResponse({ status: 201, body: { Id: "noname" } });
    mock.queueResponse({ status: 204, body: null });
    mock.queueResponse({
      status: 200,
      body: { Id: "noname", NetworkSettings: { Ports: {} } },
    });

    const runner = new DockerRunner({ socketPath: mock.socketPath });
    const result = await runner.run({ image: "whatever:latest" });
    expect(result.containerId).toBe("noname");
    expect(result.boundPorts).toEqual([]);

    const [create] = mock.captured;
    expect(create.url).not.toContain("name=");
  });

  test("removes container when start fails", async () => {
    mock = await startMockDocker();
    mock.queueResponse({ status: 201, body: { Id: "fail1" } });
    mock.queueResponse({ status: 500, body: "boom" });
    // Cleanup: remove
    mock.queueResponse({ status: 204, body: null });

    const runner = new DockerRunner({ socketPath: mock.socketPath });
    await expect(runner.run({ image: "x:y" })).rejects.toThrow(DockerApiError);

    // Create + start + cleanup remove = 3 calls.
    expect(mock.captured).toHaveLength(3);
    expect(mock.captured[2].method).toBe("DELETE");
    expect(mock.captured[2].url).toContain("/containers/fail1");
  });
});

describe("DockerRunner.stop", () => {
  let mock: MockDocker;

  afterEach(async () => {
    await mock?.close();
  });

  test("issues POST /containers/<id>/stop with timeout query", async () => {
    mock = await startMockDocker();
    mock.queueResponse({ status: 204, body: null });

    const runner = new DockerRunner({ socketPath: mock.socketPath });
    await runner.stop("cid", 7);

    expect(mock.captured).toHaveLength(1);
    expect(mock.captured[0].method).toBe("POST");
    expect(mock.captured[0].url).toContain("/containers/cid/stop");
    expect(mock.captured[0].url).toContain("t=7");
  });

  test("treats 304 (already stopped) as success", async () => {
    mock = await startMockDocker();
    mock.queueResponse({ status: 304, body: null });

    const runner = new DockerRunner({ socketPath: mock.socketPath });
    await expect(runner.stop("cid")).resolves.toBeUndefined();
  });

  test("propagates non-304 errors", async () => {
    mock = await startMockDocker();
    mock.queueResponse({ status: 500, body: "engine down" });

    const runner = new DockerRunner({ socketPath: mock.socketPath });
    await expect(runner.stop("cid")).rejects.toThrow(DockerApiError);
  });
});

describe("DockerRunner.remove", () => {
  let mock: MockDocker;

  afterEach(async () => {
    await mock?.close();
  });

  test("issues DELETE /containers/<id>?force=true&v=true", async () => {
    mock = await startMockDocker();
    mock.queueResponse({ status: 204, body: null });

    const runner = new DockerRunner({ socketPath: mock.socketPath });
    await runner.remove("cid");

    expect(mock.captured).toHaveLength(1);
    expect(mock.captured[0].method).toBe("DELETE");
    expect(mock.captured[0].url).toContain("/containers/cid");
    expect(mock.captured[0].url).toContain("force=true");
    expect(mock.captured[0].url).toContain("v=true");
  });

  test("treats 404 (already gone) as success", async () => {
    mock = await startMockDocker();
    mock.queueResponse({ status: 404, body: "no such container" });

    const runner = new DockerRunner({ socketPath: mock.socketPath });
    await expect(runner.remove("cid")).resolves.toBeUndefined();
  });
});

describe("DockerRunner.inspect", () => {
  let mock: MockDocker;

  afterEach(async () => {
    await mock?.close();
  });

  test("issues GET /containers/<id>/json and parses response", async () => {
    mock = await startMockDocker();
    mock.queueResponse({
      status: 200,
      body: { Id: "cid", State: { Running: true } },
    });

    const runner = new DockerRunner({ socketPath: mock.socketPath });
    const result = await runner.inspect("cid");

    expect(result.Id).toBe("cid");
    expect(result.State?.Running).toBe(true);
    expect(mock.captured[0].method).toBe("GET");
    expect(mock.captured[0].url).toContain("/containers/cid/json");
  });
});

// ---------------------------------------------------------------------------
// Helper-function unit tests
// ---------------------------------------------------------------------------

describe("buildCreateBody", () => {
  test("serializes env + binds + ports + network and always sets host-gateway", () => {
    const body = buildCreateBody({
      image: "foo:bar",
      env: { A: "1", B: "two" },
      binds: [
        { hostPath: "/h", containerPath: "/c" },
        { hostPath: "/h2", containerPath: "/c2", readOnly: true },
      ],
      ports: [
        { hostIp: "127.0.0.1", hostPort: 0, containerPort: 3000 },
        {
          hostIp: "0.0.0.0",
          hostPort: 9000,
          containerPort: 9000,
          protocol: "udp",
        },
      ],
      network: "host",
    });
    expect(body.Image).toBe("foo:bar");
    expect(body.Env).toEqual(["A=1", "B=two"]);
    expect(body.ExposedPorts).toEqual({
      "3000/tcp": {},
      "9000/udp": {},
    });
    const hc = body.HostConfig as Record<string, unknown>;
    expect(hc.Binds).toEqual(["/h:/c", "/h2:/c2:ro"]);
    expect(hc.NetworkMode).toBe("host");
    expect(hc.PortBindings).toEqual({
      "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
      "9000/udp": [{ HostIp: "0.0.0.0", HostPort: "9000" }],
    });
    // host-gateway is always appended so Linux bots can reach the daemon.
    expect(hc.ExtraHosts).toEqual([HOST_GATEWAY_ALIAS]);
    // Mounts is omitted entirely when no named-volume mounts resolved.
    expect(hc.Mounts).toBeUndefined();
  });

  test("appends extraBinds from resolved workspace mounts (bare-metal mode)", () => {
    const body = buildCreateBody(
      {
        image: "x:y",
        binds: [{ hostPath: "/explicit", containerPath: "/mnt" }],
      },
      {
        extraBinds: [
          {
            hostPath: "/ws/meets/abc/sockets",
            containerPath: "/sockets",
          },
          {
            hostPath: "/ws/meets/abc/out",
            containerPath: "/out",
            readOnly: true,
          },
        ],
        mounts: [],
      },
    );
    const hc = body.HostConfig as Record<string, unknown>;
    expect(hc.Binds).toEqual([
      "/explicit:/mnt",
      "/ws/meets/abc/sockets:/sockets",
      "/ws/meets/abc/out:/out:ro",
    ]);
    // No Mounts field emitted in the bare-metal branch.
    expect(hc.Mounts).toBeUndefined();
  });

  test("serializes named-volume mounts via HostConfig.Mounts (Docker mode)", () => {
    const body = buildCreateBody(
      { image: "x:y" },
      {
        extraBinds: [],
        mounts: [
          {
            Type: "volume",
            Source: "vellum-work",
            Target: "/sockets",
            ReadOnly: false,
            VolumeOptions: { Subpath: "meets/abc/sockets" },
          },
          {
            Type: "volume",
            Source: "vellum-work",
            Target: "/out",
            ReadOnly: true,
            VolumeOptions: { Subpath: "meets/abc/out" },
          },
        ],
      },
    );
    const hc = body.HostConfig as Record<string, unknown>;
    expect(hc.Binds).toEqual([]);
    expect(hc.Mounts).toEqual([
      {
        Type: "volume",
        Source: "vellum-work",
        Target: "/sockets",
        ReadOnly: false,
        VolumeOptions: { Subpath: "meets/abc/sockets" },
      },
      {
        Type: "volume",
        Source: "vellum-work",
        Target: "/out",
        ReadOnly: true,
        VolumeOptions: { Subpath: "meets/abc/out" },
      },
    ]);
  });
});

describe("resolveWorkspaceSubpath", () => {
  test("joins a relative subpath under the workspace dir", () => {
    expect(resolveWorkspaceSubpath("/ws", "meets/abc/sockets")).toBe(
      "/ws/meets/abc/sockets",
    );
  });

  test("tolerates leading slashes in the subpath", () => {
    expect(resolveWorkspaceSubpath("/ws", "/meets/abc")).toBe("/ws/meets/abc");
  });
});

describe("extractBoundPorts", () => {
  test("flattens NetworkSettings.Ports into a typed list", () => {
    const ports = extractBoundPorts({
      Id: "x",
      NetworkSettings: {
        Ports: {
          "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }],
          "80/tcp": null, // declared but unbound — skip
          "9000/udp": [{ HostIp: "0.0.0.0", HostPort: "9000" }],
        },
      },
    });
    expect(ports).toEqual([
      {
        protocol: "tcp",
        containerPort: 3000,
        hostIp: "127.0.0.1",
        hostPort: 49152,
      },
      {
        protocol: "udp",
        containerPort: 9000,
        hostIp: "0.0.0.0",
        hostPort: 9000,
      },
    ]);
  });

  test("returns empty list when NetworkSettings is absent", () => {
    expect(extractBoundPorts({ Id: "x" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mode-aware workspace mounts + host-gateway flag (Phase 1.8)
// ---------------------------------------------------------------------------

describe("DockerRunner workspace-mount mode branching", () => {
  let mock: MockDocker;

  afterEach(async () => {
    await mock?.close();
  });

  test("bare-metal mode translates workspaceMounts to host-path binds and always sets host-gateway", async () => {
    mock = await startMockDocker();
    mock.queueResponse({ status: 201, body: { Id: "bm-1" } });
    mock.queueResponse({ status: 204, body: null });
    mock.queueResponse({
      status: 200,
      body: { Id: "bm-1", NetworkSettings: { Ports: {} } },
    });

    const resolveWorkspaceVolumeName = async () => {
      throw new Error(
        "resolveWorkspaceVolumeName must not be called in bare-metal mode",
      );
    };
    const runner = new DockerRunner({
      socketPath: mock.socketPath,
      resolveMode: () => "bare-metal",
      resolveWorkspaceVolumeName,
      workspaceDir: "/ws",
    });

    await runner.run({
      image: "vellum-meet-bot:dev",
      workspaceMounts: [
        { target: "/sockets", subpath: "meets/m1/sockets" },
        { target: "/out", subpath: "meets/m1/out" },
      ],
    });

    // Bare-metal mode skips the /_ping probe; only create + start + inspect.
    expect(mock.captured).toHaveLength(3);

    const createBody = JSON.parse(mock.captured[0].body);
    expect(createBody.HostConfig.Binds).toEqual([
      "/ws/meets/m1/sockets:/sockets",
      "/ws/meets/m1/out:/out",
    ]);
    expect(createBody.HostConfig.Mounts).toBeUndefined();
    expect(createBody.HostConfig.ExtraHosts).toEqual([HOST_GATEWAY_ALIAS]);
  });

  test("Docker mode probes the socket, translates workspaceMounts to named-volume subpath mounts, and sets host-gateway", async () => {
    mock = await startMockDocker();
    // /_ping → create → start → inspect
    mock.queueResponse({ status: 200, body: "OK" });
    mock.queueResponse({ status: 201, body: { Id: "dk-1" } });
    mock.queueResponse({ status: 204, body: null });
    mock.queueResponse({
      status: 200,
      body: {
        Id: "dk-1",
        NetworkSettings: {
          Ports: {
            "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49200" }],
          },
        },
      },
    });

    const runner = new DockerRunner({
      socketPath: mock.socketPath,
      resolveMode: () => "docker",
      resolveWorkspaceVolumeName: async () => "vellum-inst-workspace",
      // workspaceDir unused in Docker mode.
      workspaceDir: "/irrelevant",
    });

    const result = await runner.run({
      image: "vellum-meet-bot:dev",
      workspaceMounts: [
        { target: "/sockets", subpath: "meets/m1/sockets" },
        { target: "/out", subpath: "meets/m1/out", readOnly: true },
      ],
      ports: [
        {
          hostIp: "127.0.0.1",
          hostPort: 0,
          containerPort: 3000,
          protocol: "tcp",
        },
      ],
      name: "vellum-meet-m1",
    });

    expect(result.containerId).toBe("dk-1");

    // /_ping first, then create/start/inspect.
    expect(mock.captured).toHaveLength(4);
    expect(mock.captured[0].method).toBe("GET");
    expect(mock.captured[0].url).toContain("/_ping");

    const createBody = JSON.parse(mock.captured[1].body);
    expect(createBody.HostConfig.Binds).toEqual([]);
    expect(createBody.HostConfig.Mounts).toEqual([
      {
        Type: "volume",
        Source: "vellum-inst-workspace",
        Target: "/sockets",
        ReadOnly: false,
        VolumeOptions: { Subpath: "meets/m1/sockets" },
      },
      {
        Type: "volume",
        Source: "vellum-inst-workspace",
        Target: "/out",
        ReadOnly: true,
        VolumeOptions: { Subpath: "meets/m1/out" },
      },
    ]);
    expect(createBody.HostConfig.ExtraHosts).toEqual([HOST_GATEWAY_ALIAS]);
  });

  test("Docker mode throws when workspace volume name is null — and never attempts create", async () => {
    mock = await startMockDocker();
    // Only /_ping should be consumed before we bail on the volume lookup.
    mock.queueResponse({ status: 200, body: "OK" });

    const runner = new DockerRunner({
      socketPath: mock.socketPath,
      resolveMode: () => "docker",
      resolveWorkspaceVolumeName: async () => null,
    });

    await expect(
      runner.run({
        image: "vellum-meet-bot:dev",
        workspaceMounts: [
          { target: "/sockets", subpath: "meets/m1/sockets" },
        ],
      }),
    ).rejects.toThrow(DOCKER_WORKSPACE_VOLUME_MISSING_MESSAGE);

    // Only the ping round-trip happened; no create was issued.
    expect(mock.captured).toHaveLength(1);
    expect(mock.captured[0].url).toContain("/_ping");
  });

  test("Docker mode surfaces the prerequisite-missing error when the socket is unreachable", async () => {
    // Use a bogus socket path — no server listening there.
    const runner = new DockerRunner({
      socketPath: join(tempDir, "nonexistent.sock"),
      resolveMode: () => "docker",
      resolveWorkspaceVolumeName: async () => "vellum-inst-workspace",
    });

    await expect(
      runner.run({
        image: "vellum-meet-bot:dev",
        workspaceMounts: [
          { target: "/sockets", subpath: "meets/m1/sockets" },
        ],
      }),
    ).rejects.toThrow(DOCKER_SOCKET_UNREACHABLE_MESSAGE);
  });

  test("Docker-mode ping success is memoized across run() calls", async () => {
    mock = await startMockDocker();
    // First run: /_ping + create + start + inspect (4).
    mock.queueResponse({ status: 200, body: "OK" });
    mock.queueResponse({ status: 201, body: { Id: "m-1" } });
    mock.queueResponse({ status: 204, body: null });
    mock.queueResponse({
      status: 200,
      body: { Id: "m-1", NetworkSettings: { Ports: {} } },
    });
    // Second run skips /_ping — create + start + inspect (3).
    mock.queueResponse({ status: 201, body: { Id: "m-2" } });
    mock.queueResponse({ status: 204, body: null });
    mock.queueResponse({
      status: 200,
      body: { Id: "m-2", NetworkSettings: { Ports: {} } },
    });

    const runner = new DockerRunner({
      socketPath: mock.socketPath,
      resolveMode: () => "docker",
      resolveWorkspaceVolumeName: async () => "vol",
    });

    await runner.run({
      image: "x:y",
      workspaceMounts: [{ target: "/sockets", subpath: "meets/m-1/sockets" }],
    });
    await runner.run({
      image: "x:y",
      workspaceMounts: [{ target: "/sockets", subpath: "meets/m-2/sockets" }],
    });

    // 4 + 3 = 7. If the ping were not memoized we'd see 8.
    expect(mock.captured).toHaveLength(7);
    const pingCalls = mock.captured.filter((c) => c.url.includes("/_ping"));
    expect(pingCalls).toHaveLength(1);
  });
});
