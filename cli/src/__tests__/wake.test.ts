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
import * as local from "../lib/local.js";
import * as ngrok from "../lib/ngrok.js";
import * as processLib from "../lib/process.js";
import type { AssistantEntry } from "../lib/assistant-config.js";

const realAssistantConfig = { ...assistantConfig };
const realDocker = { ...docker };
const realGuardianToken = { ...guardianToken };
const realLocal = { ...local };
const realNgrok = { ...ngrok };
const realProcessLib = { ...processLib };

const resolveTargetAssistantMock = mock<
  typeof assistantConfig.resolveTargetAssistant
>();
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
  () => ({ accessToken: "existing" }) as ReturnType<
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

mock.module("../lib/process", () => ({
  ...realProcessLib,
  resolveProcessState: resolveProcessStateMock,
  stopProcessByPidFile: stopProcessByPidFileMock,
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
const startLocalDaemonMock = mock<typeof local.startLocalDaemon>(async () => {});
const startGatewayMock = mock<typeof local.startGateway>(
  async () => "http://127.0.0.1:7830",
);

mock.module("../lib/local", () => ({
  ...realLocal,
  generateLocalSigningKey: generateLocalSigningKeyMock,
  isAssistantWatchModeAvailable: isAssistantWatchModeAvailableMock,
  isGatewayWatchModeAvailable: isGatewayWatchModeAvailableMock,
  startLocalDaemon: startLocalDaemonMock,
  startGateway: startGatewayMock,
}));

const maybeStartNgrokTunnelMock = mock<typeof ngrok.maybeStartNgrokTunnel>(
  async () => null,
);

mock.module("../lib/ngrok", () => ({
  ...realNgrok,
  maybeStartNgrokTunnel: maybeStartNgrokTunnelMock,
}));

const { wake } = await import("../commands/wake.js");

let tempDir: string;
let originalArgv: string[];
let logSpy: ReturnType<typeof spyOn>;

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

  const entry = makeLocalEntry();
  resolveTargetAssistantMock.mockReset();
  resolveTargetAssistantMock.mockReturnValue(entry);
  saveAssistantEntryMock.mockReset();
  getDaemonPidPathMock.mockReset();
  getDaemonPidPathMock.mockImplementation((resources) =>
    join(resources!.instanceDir, ".vellum", "daemon.pid"),
  );
  resolveProcessStateMock.mockReset();
  resolveProcessStateMock.mockImplementation(async (_pidFile, _port, label) => ({
    status: "healthy",
    pid: label === "Gateway" ? 456 : 123,
  }));
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
  seedGuardianTokenFromSiblingEnvMock.mockReset();
  seedGuardianTokenFromSiblingEnvMock.mockReturnValue(false);
  loadGuardianTokenMock.mockReset();
  loadGuardianTokenMock.mockReturnValue({ accessToken: "existing" } as ReturnType<
    typeof guardianToken.loadGuardianToken
  >);
  resetGuardianBootstrapMock.mockReset();
  resetGuardianBootstrapMock.mockResolvedValue(undefined);
  leaseGuardianTokenMock.mockReset();
  leaseGuardianTokenMock.mockResolvedValue(
    {} as Awaited<ReturnType<typeof guardianToken.leaseGuardianToken>>,
  );
  maybeStartNgrokTunnelMock.mockReset();
  maybeStartNgrokTunnelMock.mockResolvedValue(null);
});

afterEach(() => {
  process.argv = originalArgv;
  logSpy.mockRestore();
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
    process.argv = ["bun", "vellum", "wake", "--repair-guardian", "local-assistant"];
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
    process.argv = ["bun", "vellum", "wake", "--repair-guardian", "local-assistant"];
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
});
