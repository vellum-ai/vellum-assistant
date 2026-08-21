import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as assistantConfig from "../lib/assistant-config.js";
import * as docker from "../lib/docker.js";
import * as guardianToken from "../lib/guardian-token.js";
import * as httpClient from "../lib/http-client.js";
import * as ingressConfig from "../lib/ingress-config.js";
import * as local from "../lib/local.js";
import * as nginxIngress from "../lib/nginx-ingress.js";
import * as ngrok from "../lib/ngrok.js";
import * as processLib from "../lib/process.js";
import type { AssistantEntry } from "../lib/assistant-config.js";

const realAssistantConfig = { ...assistantConfig };
const realDocker = { ...docker };
const realGuardianToken = { ...guardianToken };
const realLocal = { ...local };
const realNgrok = { ...ngrok };
const realProcessLib = { ...processLib };

const resolveTargetAssistantMock =
  mock<typeof assistantConfig.resolveTargetAssistant>();
const loadAllAssistantsMock = mock<typeof assistantConfig.loadAllAssistants>(
  () => [],
);
const loadAllAssistantsAcrossEnvsMock = mock<
  typeof assistantConfig.loadAllAssistantsAcrossEnvs
>(() => []);
const saveAssistantEntryMock = mock<typeof assistantConfig.saveAssistantEntry>(
  () => {},
);
const getDaemonPidPathMock = mock<typeof assistantConfig.getDaemonPidPath>(
  (resources) => join(resources!.instanceDir, ".vellum", "daemon.pid"),
);

mock.module("../lib/assistant-config.js", () => ({
  ...realAssistantConfig,
  resolveTargetAssistant: resolveTargetAssistantMock,
  loadAllAssistants: loadAllAssistantsMock,
  loadAllAssistantsAcrossEnvs: loadAllAssistantsAcrossEnvsMock,
  saveAssistantEntry: saveAssistantEntryMock,
  getDaemonPidPath: getDaemonPidPathMock,
}));

const dockerResourceNamesMock = mock<typeof docker.dockerResourceNames>(
  realDocker.dockerResourceNames,
);
const wakeContainersMock = mock<typeof docker.wakeContainers>(async () => {});

mock.module("../lib/docker.js", () => ({
  ...realDocker,
  dockerResourceNames: dockerResourceNamesMock,
  wakeContainers: wakeContainersMock,
}));

const seedGuardianTokenFromSiblingEnvMock = mock<
  typeof guardianToken.seedGuardianTokenFromSiblingEnv
>(() => false);
// Default: a token exists, so the re-provision recovery path is skipped. Tests
// that exercise recovery override loadGuardianToken to return null.
const loadGuardianTokenMock = mock<typeof guardianToken.loadGuardianToken>(
  () =>
    ({ accessToken: "existing" }) as ReturnType<
      typeof guardianToken.loadGuardianToken
    >,
);
const resetGuardianBootstrapMock = mock<
  typeof guardianToken.resetGuardianBootstrap
>(async () => {});
const leaseGuardianTokenMock = mock<typeof guardianToken.leaseGuardianToken>(
  async () =>
    ({}) as Awaited<ReturnType<typeof guardianToken.leaseGuardianToken>>,
);

mock.module("../lib/guardian-token.js", () => ({
  ...realGuardianToken,
  seedGuardianTokenFromSiblingEnv: seedGuardianTokenFromSiblingEnvMock,
  loadGuardianToken: loadGuardianTokenMock,
  resetGuardianBootstrap: resetGuardianBootstrapMock,
  leaseGuardianToken: leaseGuardianTokenMock,
}));

const resolveProcessStateMock = mock<typeof processLib.resolveProcessState>(
  async (_pidFile, _port, label) => ({
    status: "healthy",
    pid: label === "Gateway" ? 456 : 123,
  }),
);
const stopProcessByPidFileMock = mock<typeof processLib.stopProcessByPidFile>(
  async () => true,
);
const isProcessAliveMock = mock<typeof processLib.isProcessAlive>(() => ({
  alive: false,
  pid: null,
}));

mock.module("../lib/process", () => ({
  ...realProcessLib,
  resolveProcessState: resolveProcessStateMock,
  stopProcessByPidFile: stopProcessByPidFileMock,
  isProcessAlive: isProcessAliveMock,
}));

const generateLocalSigningKeyMock = mock<typeof local.generateLocalSigningKey>(
  () => "generated-bootstrap-secret",
);
const isAssistantWatchModeAvailableMock = mock<
  typeof local.isAssistantWatchModeAvailable
>(() => false);
const isGatewayWatchModeAvailableMock = mock<
  typeof local.isGatewayWatchModeAvailable
>(() => false);
const startLocalDaemonMock = mock<typeof local.startLocalDaemon>(
  async () => {},
);
const startGatewayMock = mock<typeof local.startGateway>(
  async () => "http://127.0.0.1:7830",
);
const startCesMock = mock<typeof local.startCes>(async () => {});

mock.module("../lib/local", () => ({
  ...realLocal,
  generateLocalSigningKey: generateLocalSigningKeyMock,
  isAssistantWatchModeAvailable: isAssistantWatchModeAvailableMock,
  isGatewayWatchModeAvailable: isGatewayWatchModeAvailableMock,
  startLocalDaemon: startLocalDaemonMock,
  startGateway: startGatewayMock,
  startCes: startCesMock,
}));

const maybeStartNgrokTunnelMock = mock<typeof ngrok.maybeStartNgrokTunnel>(
  async () => null,
);

mock.module("../lib/ngrok", () => ({
  ...realNgrok,
  maybeStartNgrokTunnel: maybeStartNgrokTunnelMock,
}));

const realIngressConfig = { ...ingressConfig };
const realNginxIngress = { ...nginxIngress };

const loadRawConfigMock = mock<typeof ingressConfig.loadRawConfig>(() => ({}));

mock.module("../lib/ingress-config.js", () => ({
  ...realIngressConfig,
  loadRawConfig: loadRawConfigMock,
}));

const ensureTunnelEdgeMock = mock<typeof nginxIngress.ensureTunnelEdge>(
  async () => ({ port: 7840, started: true, includesWebApp: true }),
);
const isIngressRunningMock = mock<typeof nginxIngress.isIngressRunning>(
  () => false,
);
const readIngressStateMock = mock<typeof nginxIngress.readIngressState>(
  () => null,
);

mock.module("../lib/nginx-ingress.js", () => ({
  ...realNginxIngress,
  ensureTunnelEdge: ensureTunnelEdgeMock,
  isIngressRunning: isIngressRunningMock,
  readIngressState: readIngressStateMock,
}));

const realHttpClient = { ...httpClient };

const probeDaemonReadinessWithRetryMock = mock<
  typeof httpClient.probeDaemonReadinessWithRetry
>(async () => "ready");
const waitForDaemonMigrationsReadyMock = mock<
  typeof httpClient.waitForDaemonMigrationsReady
>(async () => "ready");
const waitForDaemonReadyMock = mock<typeof httpClient.waitForDaemonReady>(
  async () => true,
);

mock.module("../lib/http-client.js", () => ({
  ...realHttpClient,
  probeDaemonReadinessWithRetry: probeDaemonReadinessWithRetryMock,
  waitForDaemonMigrationsReady: waitForDaemonMigrationsReadyMock,
  waitForDaemonReady: waitForDaemonReadyMock,
}));

const { wake } = await import("../commands/wake.js");

let tempDir: string;
let originalArgv: string[];
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let localEntry: AssistantEntry;

function makeLocalEntry(): AssistantEntry {
  tempDir = mkdtempSync(join(tmpdir(), "vellum-wake-test-"));
  mkdirSync(join(tempDir, ".vellum"), { recursive: true });
  return {
    assistantId: "local-assistant",
    runtimeUrl: "http://127.0.0.1:7830",
    cloud: "local",
    resources: {
      instanceDir: tempDir,
      daemonPort: 7821,
      gatewayPort: 7830,
      qdrantPort: 6333,
      cesPort: 7822,
      signingKey: "existing-signing-key",
    },
  };
}

beforeEach(() => {
  originalArgv = [...process.argv];
  tempDir = "";
  process.argv = ["bun", "vellum", "wake", "--watch", "local-assistant"];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});

  localEntry = makeLocalEntry();
  resolveTargetAssistantMock.mockReset();
  resolveTargetAssistantMock.mockReturnValue(localEntry);
  loadAllAssistantsMock.mockReset();
  loadAllAssistantsMock.mockReturnValue([]);
  loadAllAssistantsAcrossEnvsMock.mockReset();
  loadAllAssistantsAcrossEnvsMock.mockReturnValue([]);
  saveAssistantEntryMock.mockReset();
  getDaemonPidPathMock.mockReset();
  getDaemonPidPathMock.mockImplementation((resources) =>
    join(resources!.instanceDir, ".vellum", "daemon.pid"),
  );
  resolveProcessStateMock.mockReset();
  resolveProcessStateMock.mockImplementation(
    async (_pidFile, _port, label) => ({
      status: "healthy",
      pid: label === "Gateway" ? 456 : 123,
    }),
  );
  stopProcessByPidFileMock.mockReset();
  stopProcessByPidFileMock.mockResolvedValue(true);
  generateLocalSigningKeyMock.mockReset();
  generateLocalSigningKeyMock.mockReturnValue("generated-bootstrap-secret");
  isAssistantWatchModeAvailableMock.mockReset();
  isAssistantWatchModeAvailableMock.mockReturnValue(false);
  isGatewayWatchModeAvailableMock.mockReset();
  isGatewayWatchModeAvailableMock.mockReturnValue(false);
  startLocalDaemonMock.mockReset();
  startLocalDaemonMock.mockResolvedValue(undefined);
  startGatewayMock.mockReset();
  startGatewayMock.mockResolvedValue("http://127.0.0.1:7830");
  startCesMock.mockReset();
  startCesMock.mockResolvedValue(undefined);
  isProcessAliveMock.mockReset();
  isProcessAliveMock.mockReturnValue({ alive: false, pid: null });
  probeDaemonReadinessWithRetryMock.mockReset();
  probeDaemonReadinessWithRetryMock.mockResolvedValue("ready");
  waitForDaemonMigrationsReadyMock.mockReset();
  waitForDaemonMigrationsReadyMock.mockImplementation(async () => "ready");
  waitForDaemonReadyMock.mockReset();
  waitForDaemonReadyMock.mockImplementation(async () => true);
  waitForDaemonMigrationsReadyMock.mockResolvedValue("ready");
  seedGuardianTokenFromSiblingEnvMock.mockReset();
  seedGuardianTokenFromSiblingEnvMock.mockReturnValue(false);
  loadGuardianTokenMock.mockReset();
  loadGuardianTokenMock.mockReturnValue({
    accessToken: "existing",
  } as ReturnType<typeof guardianToken.loadGuardianToken>);
  resetGuardianBootstrapMock.mockReset();
  resetGuardianBootstrapMock.mockResolvedValue(undefined);
  leaseGuardianTokenMock.mockReset();
  leaseGuardianTokenMock.mockResolvedValue(
    {} as Awaited<ReturnType<typeof guardianToken.leaseGuardianToken>>,
  );
  maybeStartNgrokTunnelMock.mockReset();
  maybeStartNgrokTunnelMock.mockResolvedValue(null);
  loadRawConfigMock.mockReset();
  loadRawConfigMock.mockReturnValue({});
  ensureTunnelEdgeMock.mockReset();
  ensureTunnelEdgeMock.mockResolvedValue({
    port: 7840,
    started: true,
    includesWebApp: true,
  });
  isIngressRunningMock.mockReset();
  isIngressRunningMock.mockReturnValue(false);
  readIngressStateMock.mockReset();
  readIngressStateMock.mockReturnValue(null);
});

afterEach(() => {
  process.argv = originalArgv;
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  mock.module("../lib/assistant-config.js", () => realAssistantConfig);
  mock.module("../lib/docker.js", () => realDocker);
  mock.module("../lib/guardian-token.js", () => realGuardianToken);
  mock.module("../lib/process", () => realProcessLib);
  mock.module("../lib/local", () => realLocal);
  mock.module("../lib/ngrok", () => realNgrok);
  mock.module("../lib/ingress-config.js", () => realIngressConfig);
  mock.module("../lib/nginx-ingress.js", () => realNginxIngress);
  mock.module("../lib/http-client.js", () => realHttpClient);
});

describe("vellum wake", () => {
  test("restarts a running gateway without watch mode when backfilling the bootstrap secret", async () => {
    await wake();

    expect(saveAssistantEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        guardianBootstrapSecret: "generated-bootstrap-secret",
      }),
    );
    expect(stopProcessByPidFileMock).toHaveBeenCalledWith(
      join(tempDir, ".vellum", "gateway.pid"),
      "gateway",
    );
    expect(startGatewayMock).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ instanceDir: tempDir }),
      {
        signingKey: "existing-signing-key",
        bootstrapSecret: "generated-bootstrap-secret",
      },
    );
  });

  test("re-provisions the guardian token when missing and --repair-guardian is passed", async () => {
    process.argv = [
      "bun",
      "vellum",
      "wake",
      "--repair-guardian",
      "local-assistant",
    ];
    loadGuardianTokenMock.mockReturnValue(null);

    await wake();

    // Resets the gateway's spent bootstrap state, then re-leases against the
    // loopback gateway with the lockfile's bootstrap secret.
    expect(resetGuardianBootstrapMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      "generated-bootstrap-secret",
    );
    expect(leaseGuardianTokenMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      "local-assistant",
      "generated-bootstrap-secret",
    );
  });

  test("does NOT re-provision without --repair-guardian, even when the token is missing", async () => {
    // The automatic connect-repair path spawns `wake <id>` with no flags. A
    // re-lease here would revoke other device-bound tokens (other tabs / local
    // clients), so it must never run from auto-repair.
    process.argv = ["bun", "vellum", "wake", "local-assistant"];
    loadGuardianTokenMock.mockReturnValue(null);

    await wake();

    expect(resetGuardianBootstrapMock).not.toHaveBeenCalled();
    expect(leaseGuardianTokenMock).not.toHaveBeenCalled();
  });

  test("re-provisions even when a guardian token already exists", async () => {
    // A connect can 401 off a token whose local state looks healthy
    // (revoked, mis-seeded, wrong principal). The user explicitly confirmed
    // the destructive repair, so the flag forces a re-lease instead of
    // guessing from local token state and recreating the no-op loop.
    process.argv = [
      "bun",
      "vellum",
      "wake",
      "--repair-guardian",
      "local-assistant",
    ];
    // loadGuardianToken returns a healthy-looking token by default.
    await wake();

    expect(resetGuardianBootstrapMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      "generated-bootstrap-secret",
    );
    expect(leaseGuardianTokenMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      "local-assistant",
      "generated-bootstrap-secret",
    );
  });

  test("relaunches CES sibling when daemon is healthy but CES is dead", async () => {
    // Daemon is healthy (default mock) but CES pid says dead.
    // isProcessAliveMock defaults to { alive: false }.
    await wake();

    // startCes should be called to relaunch the dead sibling.
    expect(startCesMock).toHaveBeenCalledTimes(1);
    // startLocalDaemon should NOT be called (daemon already running).
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
  });

  test("does NOT relaunch CES sibling when both daemon and CES are healthy", async () => {
    // Daemon is healthy (default mock). CES is also alive.
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 789 });

    await wake();

    // startCes should NOT be called (CES is alive).
    expect(startCesMock).not.toHaveBeenCalled();
    // startLocalDaemon should NOT be called (daemon already running).
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
  });

  test("does not duplicate an assistant already classified as stuck", async () => {
    localEntry.guardianBootstrapSecret = "existing-bootstrap-secret";
    resolveProcessStateMock.mockImplementation(
      async (_pidFile, _port, label) =>
        label === "Assistant"
          ? { status: "stuck", pid: 123 }
          : { status: "healthy", pid: 456 },
    );

    await wake();

    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not be stopped"),
    );
  });

  test("does not duplicate an assistant when a watch restart cannot stop it", async () => {
    localEntry.guardianBootstrapSecret = "existing-bootstrap-secret";
    isAssistantWatchModeAvailableMock.mockReturnValue(true);
    stopProcessByPidFileMock.mockResolvedValue(false);
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 123 });

    await wake();

    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not be stopped for watch mode"),
    );
  });

  test("does not duplicate a gateway already classified as stuck", async () => {
    localEntry.guardianBootstrapSecret = "existing-bootstrap-secret";
    resolveProcessStateMock.mockImplementation(
      async (_pidFile, _port, label) =>
        label === "Gateway"
          ? { status: "stuck", pid: 456 }
          : { status: "healthy", pid: 123 },
    );

    await wake();

    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Gateway running"),
    );
  });

  test("does not duplicate a gateway when a watch restart cannot stop it", async () => {
    localEntry.guardianBootstrapSecret = "existing-bootstrap-secret";
    isGatewayWatchModeAvailableMock.mockReturnValue(true);
    stopProcessByPidFileMock.mockResolvedValue(false);
    isProcessAliveMock.mockImplementation((pidFile) =>
      pidFile.endsWith("gateway.pid")
        ? { alive: true, pid: 456 }
        : { alive: false, pid: null },
    );

    await wake();

    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Gateway running"),
    );
  });
});

describe("vellum wake: daemon startup failure", () => {
  const daemonPidOf = (dir: string) => join(dir, ".vellum", "daemon.pid");

  beforeEach(() => {
    process.argv = ["bun", "vellum", "wake", "local-assistant"];
    // The daemon needs starting; the gateway is already serving.
    resolveProcessStateMock.mockImplementation(
      async (_pidFile, _port, label) =>
        label === "Gateway"
          ? { status: "healthy", pid: 456 }
          : { status: "needs_start", pid: null },
    );
  });

  test("fails when the freshly spawned daemon is not running", async () => {
    /**
     * Tests that a daemon which aborts during startup (an occupied runtime
     * HTTP port) fails the command instead of reporting a successful wake.
     */

    // GIVEN the spawned daemon left no live process behind
    isProcessAliveMock.mockReturnValue({ alive: false, pid: null });

    // AND a foreign listener on the runtime HTTP port answers readiness in
    // the dead daemon's place
    probeDaemonReadinessWithRetryMock.mockResolvedValue("ready");
    const exitSpy = spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    // WHEN wake runs
    const result = wake();

    // THEN it exits nonzero, names the port on stderr, and never claims
    // the wake completed
    await expect(result).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("exited during startup"),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("7821"));
    expect(logSpy).not.toHaveBeenCalledWith("Wake complete.");
    expect(startGatewayMock).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  test("completes when the freshly spawned daemon is running", async () => {
    /**
     * Tests that a healthy fresh spawn still reports a completed wake.
     */

    // GIVEN the spawned daemon is alive and ready
    isProcessAliveMock.mockImplementation((pidFile) =>
      pidFile === daemonPidOf(tempDir)
        ? { alive: true, pid: 123 }
        : { alive: false, pid: null },
    );
    probeDaemonReadinessWithRetryMock.mockResolvedValue("ready");

    // WHEN wake runs
    await wake();

    // THEN it reports success and starts the gateway
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    expect(errorSpy).not.toHaveBeenCalled();
    expect(startLocalDaemonMock).toHaveBeenCalledTimes(1);
  });

  test("completes when the freshly spawned daemon is still migrating", async () => {
    /**
     * Tests that a live daemon running database migrations is reported as a
     * degraded success, not a failure.
     */

    // GIVEN the spawned daemon is alive but still migrating past the
    // gateway-coordination wait
    isProcessAliveMock.mockImplementation((pidFile) =>
      pidFile === daemonPidOf(tempDir)
        ? { alive: true, pid: 123 }
        : { alive: false, pid: null },
    );
    probeDaemonReadinessWithRetryMock.mockResolvedValue("migrating");
    waitForDaemonMigrationsReadyMock.mockResolvedValue("migrating");

    // WHEN wake runs
    await wake();

    // THEN it reports the migration state and completes
    expect(logSpy).toHaveBeenCalledWith(
      "Assistant is still running database migrations; DB-backed routes return 503 until they finish.",
    );
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });
});

describe("vellum wake — tunnel edge restore", () => {
  const webhookConfig = { telegram: { botUsername: "bot" } };
  const enabledConfig = {
    ingress: { enabled: true, publicBaseUrl: "https://assistant.example.com" },
  };
  const workspaceDirOf = (dir: string) => join(dir, ".vellum", "workspace");

  beforeEach(() => {
    process.argv = ["bun", "vellum", "wake", "local-assistant"];
  });

  test("webhook-configured wake ensures the edge and tunnels the edge port", async () => {
    loadRawConfigMock.mockReturnValue(webhookConfig);

    await wake();

    expect(ensureTunnelEdgeMock).toHaveBeenCalledWith({
      assistantId: "local-assistant",
      workspaceDir: workspaceDirOf(tempDir),
      gatewayPort: 7830,
    });
    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7840,
      workspaceDirOf(tempDir),
      "local-assistant",
    );
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });

  test("ingress-enabled wake ensures the edge even without webhook integrations", async () => {
    loadRawConfigMock.mockReturnValue(enabledConfig);

    await wake();

    expect(ensureTunnelEdgeMock).toHaveBeenCalledWith({
      assistantId: "local-assistant",
      workspaceDir: workspaceDirOf(tempDir),
      gatewayPort: 7830,
    });
    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7840,
      workspaceDirOf(tempDir),
      "local-assistant",
    );
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });

  test("a docker wake restores the shared default-workspace edge", async () => {
    const defaultWorkspace = mkdtempSync(
      join(tmpdir(), "vellum-wake-default-"),
    );
    const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
      ingressUrl: "https://assistant.example.com",
    } as AssistantEntry);
    loadRawConfigMock.mockReturnValue(enabledConfig);
    process.argv = ["bun", "vellum", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureTunnelEdgeMock).toHaveBeenCalledWith({
        assistantId: "docker-1",
        workspaceDir: defaultWorkspace,
        gatewayPort: 7930,
      });
      // Container wakes never tracked a spawned ngrok PID, so the auto-tunnel
      // stays out of this path.
      expect(maybeStartNgrokTunnelMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake leaves an edge fronting another container alone", async () => {
    const defaultWorkspace = mkdtempSync(
      join(tmpdir(), "vellum-wake-default-"),
    );
    const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
      ingressUrl: "https://assistant.example.com",
    } as AssistantEntry);
    loadRawConfigMock.mockReturnValue(enabledConfig);
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7840,
      includeWebApp: true,
      gatewayPort: 8030,
    });
    process.argv = ["bun", "vellum", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake adopts an edge that already fronts it", async () => {
    const defaultWorkspace = mkdtempSync(
      join(tmpdir(), "vellum-wake-default-"),
    );
    const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
      ingressUrl: "https://assistant.example.com",
    } as AssistantEntry);
    loadRawConfigMock.mockReturnValue(enabledConfig);
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7840,
      includeWebApp: true,
      gatewayPort: 7930,
    });
    // Ownership clears the restore, and `ensureTunnelEdge` is what decides the
    // running edge still matches: it reports the reuse rather than a restart.
    ensureTunnelEdgeMock.mockResolvedValue({
      port: 7840,
      started: false,
      includesWebApp: true,
    });
    process.argv = ["bun", "vellum", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureTunnelEdgeMock).toHaveBeenCalledWith({
        assistantId: "docker-1",
        workspaceDir: defaultWorkspace,
        gatewayPort: 7930,
      });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("already running on 127.0.0.1:7840"),
      );
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a failed docker edge restore does not claim webhooks still work", async () => {
    const defaultWorkspace = mkdtempSync(
      join(tmpdir(), "vellum-wake-default-"),
    );
    const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
      ingressUrl: "https://assistant.example.com",
    } as AssistantEntry);
    loadRawConfigMock.mockReturnValue(enabledConfig);
    ensureTunnelEdgeMock.mockRejectedValue(
      new Error("nginx is not installed."),
    );
    process.argv = ["bun", "vellum", "wake", "docker-1"];

    try {
      await wake();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("webhook delivery are unavailable"),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Webhooks still work"),
      );
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake leaves a saved ingress owned by another container alone", async () => {
    const defaultWorkspace = mkdtempSync(
      join(tmpdir(), "vellum-wake-default-"),
    );
    const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = defaultWorkspace;
    // The edge is stopped, so its gatewayPort record is gone; only the saved
    // publicBaseUrl and its owner's `ingressUrl` say whose endpoint this is.
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
      ingressUrl: "https://other.example.com",
    } as AssistantEntry);
    loadAllAssistantsMock.mockReturnValue([
      {
        assistantId: "docker-2",
        runtimeUrl: "http://localhost:8030",
        cloud: "docker",
        ingressUrl: "https://assistant.example.com",
      } as AssistantEntry,
    ]);
    loadRawConfigMock.mockReturnValue(enabledConfig);
    isIngressRunningMock.mockReturnValue(false);
    process.argv = ["bun", "vellum", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake waits for the gateway before restoring the edge", async () => {
    const defaultWorkspace = mkdtempSync(
      join(tmpdir(), "vellum-wake-default-"),
    );
    const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
      ingressUrl: "https://assistant.example.com",
    } as AssistantEntry);
    loadRawConfigMock.mockReturnValue(enabledConfig);
    process.argv = ["bun", "vellum", "wake", "docker-1"];

    try {
      await wake();

      expect(waitForDaemonReadyMock).toHaveBeenCalledWith(7930, 5 * 60_000);
      expect(ensureTunnelEdgeMock).toHaveBeenCalled();
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake skips the edge when the gateway never comes up", async () => {
    const defaultWorkspace = mkdtempSync(
      join(tmpdir(), "vellum-wake-default-"),
    );
    const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
      ingressUrl: "https://assistant.example.com",
    } as AssistantEntry);
    loadRawConfigMock.mockReturnValue(enabledConfig);
    waitForDaemonReadyMock.mockImplementation(async () => false);
    process.argv = ["bun", "vellum", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("did not come up"),
      );
      expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake with no ingress config never waits for the gateway", async () => {
    const defaultWorkspace = mkdtempSync(
      join(tmpdir(), "vellum-wake-default-"),
    );
    const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    } as AssistantEntry);
    process.argv = ["bun", "vellum", "wake", "docker-1"];

    try {
      await wake();

      expect(waitForDaemonReadyMock).not.toHaveBeenCalled();
      expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake restores a saved ingress that no entry claims", async () => {
    const defaultWorkspace = mkdtempSync(
      join(tmpdir(), "vellum-wake-default-"),
    );
    const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = defaultWorkspace;
    // Tunneled before the lockfile mirror existed: publicBaseUrl is saved but
    // no entry carries `ingressUrl`. The sole container still owns it.
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    } as AssistantEntry);
    loadAllAssistantsMock.mockReturnValue([
      {
        assistantId: "docker-1",
        runtimeUrl: "http://localhost:7930",
        cloud: "docker",
      } as AssistantEntry,
    ]);
    loadRawConfigMock.mockReturnValue(enabledConfig);
    isIngressRunningMock.mockReturnValue(false);
    process.argv = ["bun", "vellum", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureTunnelEdgeMock).toHaveBeenCalledWith({
        assistantId: "docker-1",
        workspaceDir: defaultWorkspace,
        gatewayPort: 7930,
      });
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake respects an ingress claim from another environment", async () => {
    const defaultWorkspace = mkdtempSync(
      join(tmpdir(), "vellum-wake-default-"),
    );
    const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    } as AssistantEntry);
    loadAllAssistantsAcrossEnvsMock.mockReturnValue([
      {
        assistantId: "docker-2",
        runtimeUrl: "http://localhost:8030",
        cloud: "docker",
        ingressUrl: "https://assistant.example.com",
      } as AssistantEntry,
    ]);
    loadRawConfigMock.mockReturnValue(enabledConfig);
    isIngressRunningMock.mockReturnValue(false);
    process.argv = ["bun", "vellum", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake without an ingress config leaves the edge alone", async () => {
    const defaultWorkspace = mkdtempSync(
      join(tmpdir(), "vellum-wake-default-"),
    );
    const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
      ingressUrl: "https://assistant.example.com",
    } as AssistantEntry);
    process.argv = ["bun", "vellum", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("skips the edge and tunnels the gateway port when nothing wants an edge", async () => {
    await wake();

    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7830,
      workspaceDirOf(tempDir),
      "local-assistant",
    );
  });

  test("skips the edge when ingress is disabled and no webhooks are configured", async () => {
    loadRawConfigMock.mockReturnValue({ ingress: { enabled: false } });

    await wake();

    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7830,
      workspaceDirOf(tempDir),
      "local-assistant",
    );
  });

  test("skips the edge when ingress is enabled but the public URL is missing", async () => {
    loadRawConfigMock.mockReturnValue({ ingress: { enabled: true } });

    await wake();

    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
  });

  test("a running edge is rebuilt through ensureTunnelEdge, never adopted at its recorded port", async () => {
    // Recorded mode and gateway port are not a licence to reuse: only
    // ensureTunnelEdge compares the injected-config fingerprint, so an edge
    // predating the current edge template (one serving no assistantId, which
    // makes the identity probe degrade to always-healthy) must be rebuilt
    // rather than carried across the wake at its recorded listen port.
    loadRawConfigMock.mockReturnValue(webhookConfig);
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: "fingerprint-of-an-older-edge-template",
    });

    await wake();

    expect(ensureTunnelEdgeMock).toHaveBeenCalledWith({
      assistantId: "local-assistant",
      workspaceDir: workspaceDirOf(tempDir),
      gatewayPort: 7830,
    });
    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7840,
      workspaceDirOf(tempDir),
      "local-assistant",
    );
  });

  test("a failed rebuild keeps tunneling the SPA edge that is still running", async () => {
    // web-dist-missing bails before the running edge is stopped, and a drifted
    // edge whose stop fails reports staleRemoteWebConfig; both throw while the
    // edge keeps serving. Tunneling the gateway directly would put the
    // sensitive-route denylist behind the tunnel instead of in front of it.
    loadRawConfigMock.mockReturnValue(webhookConfig);
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7830,
      remoteWebConfigHash: "fingerprint-of-an-older-edge-template",
    });
    ensureTunnelEdgeMock.mockRejectedValue(
      new Error(
        "The nginx edge is still serving an outdated remote web config and could not be restarted with the updated one. Vellum could not stop the nginx process (PID 4242), even with SIGKILL. Stop it by hand and retry, or run `vellum sleep` to shut the assistant down entirely.",
      ),
    );

    await wake();

    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7845,
      workspaceDirOf(tempDir),
      "local-assistant",
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("127.0.0.1:7845"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Stop it by hand and retry"),
    );
  });

  test("a failed rebuild falls back to the gateway port when the running edge fronts another gateway", async () => {
    loadRawConfigMock.mockReturnValue(webhookConfig);
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7845,
      includeWebApp: true,
      gatewayPort: 7831,
    });
    ensureTunnelEdgeMock.mockRejectedValue(
      new Error("The nginx edge is still proxying gateway port 7831."),
    );

    await wake();

    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7830,
      workspaceDirOf(tempDir),
      "local-assistant",
    );
  });

  test("a failed rebuild falls back to the gateway port when only a webhooks-only edge survives", async () => {
    loadRawConfigMock.mockReturnValue(webhookConfig);
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7845,
      includeWebApp: false,
      gatewayPort: 7830,
    });
    ensureTunnelEdgeMock.mockRejectedValue(
      new Error("The nginx edge is still running in webhooks-only mode."),
    );

    await wake();

    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7830,
      workspaceDirOf(tempDir),
      "local-assistant",
    );
  });

  test("nginx-missing falls back to the gateway-port tunnel with a warning", async () => {
    loadRawConfigMock.mockReturnValue(webhookConfig);
    ensureTunnelEdgeMock.mockRejectedValue(
      new Error(
        "nginx is not installed, so the tunnel edge cannot start. Install it (macOS: `brew install nginx`, Linux: `sudo apt install nginx`) or point NGINX_BIN at an existing binary.",
      ),
    );

    await wake();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("brew install nginx"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Run `vellum tunnel` to rebuild the edge."),
    );
    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7830,
      workspaceDirOf(tempDir),
      "local-assistant",
    );
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });

  test("a reused edge still points the tunnel at its listen port", async () => {
    loadRawConfigMock.mockReturnValue(enabledConfig);
    ensureTunnelEdgeMock.mockResolvedValue({
      port: 7841,
      started: false,
      includesWebApp: true,
    });

    await wake();

    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7841,
      workspaceDirOf(tempDir),
      "local-assistant",
    );
  });
});
