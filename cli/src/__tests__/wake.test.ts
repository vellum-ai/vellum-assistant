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
import * as featureFlags from "../lib/feature-flags.js";
import * as guardianToken from "../lib/guardian-token.js";
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
const saveAssistantEntryMock = mock<typeof assistantConfig.saveAssistantEntry>(
  () => {},
);
const getDaemonPidPathMock = mock<typeof assistantConfig.getDaemonPidPath>(
  (resources) => join(resources!.instanceDir, ".vellum", "daemon.pid"),
);

mock.module("../lib/assistant-config.js", () => ({
  ...realAssistantConfig,
  resolveTargetAssistant: resolveTargetAssistantMock,
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
const hasWebhookIntegrationsConfiguredMock = mock<
  typeof ngrok.hasWebhookIntegrationsConfigured
>(() => false);

mock.module("../lib/ngrok", () => ({
  ...realNgrok,
  maybeStartNgrokTunnel: maybeStartNgrokTunnelMock,
  hasWebhookIntegrationsConfigured: hasWebhookIntegrationsConfiguredMock,
}));

const realFeatureFlags = { ...featureFlags };
const realIngressConfig = { ...ingressConfig };
const realNginxIngress = { ...nginxIngress };

const isAssistantFeatureFlagEnabledMock = mock<
  typeof featureFlags.isAssistantFeatureFlagEnabled
>(async () => true);

mock.module("../lib/feature-flags.js", () => ({
  ...realFeatureFlags,
  isAssistantFeatureFlagEnabled: isAssistantFeatureFlagEnabledMock,
}));

const loadRawConfigMock = mock<typeof ingressConfig.loadRawConfig>(() => ({}));

mock.module("../lib/ingress-config.js", () => ({
  ...realIngressConfig,
  loadRawConfig: loadRawConfigMock,
}));

const ensureTunnelEdgeMock = mock<typeof nginxIngress.ensureTunnelEdge>(
  async () => ({ port: 7840, started: true, includesWebApp: true }),
);

mock.module("../lib/nginx-ingress.js", () => ({
  ...realNginxIngress,
  ensureTunnelEdge: ensureTunnelEdgeMock,
}));

const { wake, WEB_INGRESS_FLAG_RETRY } = await import("../commands/wake.js");

let tempDir: string;
let originalArgv: string[];
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

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

  const entry = makeLocalEntry();
  resolveTargetAssistantMock.mockReset();
  resolveTargetAssistantMock.mockReturnValue(entry);
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
  hasWebhookIntegrationsConfiguredMock.mockReset();
  hasWebhookIntegrationsConfiguredMock.mockReturnValue(false);
  isAssistantFeatureFlagEnabledMock.mockReset();
  isAssistantFeatureFlagEnabledMock.mockResolvedValue(true);
  loadRawConfigMock.mockReset();
  loadRawConfigMock.mockReturnValue({});
  ensureTunnelEdgeMock.mockReset();
  ensureTunnelEdgeMock.mockResolvedValue({
    port: 7840,
    started: true,
    includesWebApp: true,
  });
});

afterEach(() => {
  process.argv = originalArgv;
  logSpy.mockRestore();
  warnSpy.mockRestore();
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
  mock.module("../lib/feature-flags.js", () => realFeatureFlags);
  mock.module("../lib/ingress-config.js", () => realIngressConfig);
  mock.module("../lib/nginx-ingress.js", () => realNginxIngress);
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
});

describe("vellum wake — tunnel edge restore", () => {
  const enabledConfig = {
    ingress: { enabled: true, publicBaseUrl: "https://assistant.example.com" },
  };
  const workspaceDirOf = (dir: string) => join(dir, ".vellum", "workspace");

  const originalRetry = { ...WEB_INGRESS_FLAG_RETRY };

  beforeEach(() => {
    process.argv = ["bun", "vellum", "wake", "local-assistant"];
    // Shrink the startup-window retry so failure-path tests stay fast.
    WEB_INGRESS_FLAG_RETRY.attempts = 3;
    WEB_INGRESS_FLAG_RETRY.intervalMs = 5;
  });

  afterEach(() => {
    WEB_INGRESS_FLAG_RETRY.attempts = originalRetry.attempts;
    WEB_INGRESS_FLAG_RETRY.intervalMs = originalRetry.intervalMs;
  });

  test("webhook-configured wake ensures the edge and tunnels the edge port", async () => {
    hasWebhookIntegrationsConfiguredMock.mockReturnValue(true);

    await wake();

    expect(ensureTunnelEdgeMock).toHaveBeenCalledWith({
      assistantId: "local-assistant",
      workspaceDir: workspaceDirOf(tempDir),
      gatewayPort: 7830,
    });
    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7840,
      workspaceDirOf(tempDir),
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
    );
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });

  test("skips the edge and tunnels the gateway port when nothing wants an edge", async () => {
    await wake();

    expect(isAssistantFeatureFlagEnabledMock).not.toHaveBeenCalled();
    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7830,
      workspaceDirOf(tempDir),
    );
  });

  test("skips the edge when ingress is disabled and no webhooks are configured", async () => {
    loadRawConfigMock.mockReturnValue({ ingress: { enabled: false } });

    await wake();

    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7830,
      workspaceDirOf(tempDir),
    );
  });

  test("skips the edge when ingress is enabled but the public URL is missing", async () => {
    loadRawConfigMock.mockReturnValue({ ingress: { enabled: true } });

    await wake();

    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
  });

  test("nginx-missing falls back to the gateway-port tunnel with a warning", async () => {
    hasWebhookIntegrationsConfiguredMock.mockReturnValue(true);
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
      expect.stringContaining("vellum nginx-ingress up"),
    );
    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7830,
      workspaceDirOf(tempDir),
    );
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });

  test("flag-off + webhooks-on produces a webhooks-only edge fronting the tunnel", async () => {
    hasWebhookIntegrationsConfiguredMock.mockReturnValue(true);
    isAssistantFeatureFlagEnabledMock.mockResolvedValue(false);
    ensureTunnelEdgeMock.mockResolvedValue({
      port: 7840,
      started: true,
      includesWebApp: false,
    });

    await wake();

    expect(ensureTunnelEdgeMock).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: "local-assistant" }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("webhooks only"),
    );
    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7840,
      workspaceDirOf(tempDir),
    );
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
    );
  });

  test("a failed flag probe warns and falls back to the gateway-port tunnel", async () => {
    hasWebhookIntegrationsConfiguredMock.mockReturnValue(true);
    isAssistantFeatureFlagEnabledMock.mockRejectedValue(
      new Error("gateway unreachable"),
    );

    await wake();

    // The probe retries through the startup window before giving up.
    expect(isAssistantFeatureFlagEnabledMock.mock.calls.length).toBe(3);
    expect(ensureTunnelEdgeMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7830,
      workspaceDirOf(tempDir),
    );
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });

  test("a flag probe that fails while the gateway is starting retries and then restores", async () => {
    loadRawConfigMock.mockReturnValue(enabledConfig);
    isAssistantFeatureFlagEnabledMock
      .mockRejectedValueOnce(
        new Error(
          'Failed to fetch feature flags: HTTP 503 {"status":"starting"}',
        ),
      )
      .mockRejectedValueOnce(
        new Error(
          'Failed to fetch feature flags: HTTP 503 {"status":"starting"}',
        ),
      )
      .mockResolvedValueOnce(true);

    await wake();

    expect(isAssistantFeatureFlagEnabledMock.mock.calls.length).toBe(3);
    expect(logSpy).toHaveBeenCalledWith(
      "   Waiting for the gateway before restoring the tunnel edge...",
    );
    expect(ensureTunnelEdgeMock).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });
});
