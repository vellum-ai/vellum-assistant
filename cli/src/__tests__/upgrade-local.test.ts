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

import cliPkg from "../../package.json";
import type { AssistantEntry } from "../lib/assistant-config.js";
import * as assistantConfig from "../lib/assistant-config.js";
import * as backupOps from "../lib/backup-ops.js";
import * as local from "../lib/local.js";
import * as loopbackFetch from "../lib/loopback-fetch.js";
import * as ngrok from "../lib/ngrok.js";
import * as upgradeLifecycle from "../lib/upgrade-lifecycle.js";

const realAssistantConfig = { ...assistantConfig };
const realBackupOps = { ...backupOps };
const realLocal = { ...local };
const realLoopbackFetch = { ...loopbackFetch };
const realNgrok = { ...ngrok };
const realUpgradeLifecycle = { ...upgradeLifecycle };

const findAssistantByNameMock =
  mock<typeof assistantConfig.findAssistantByName>();
const getActiveAssistantMock = mock<typeof assistantConfig.getActiveAssistant>(
  () => "local-assistant",
);
const loadAllAssistantsMock = mock<typeof assistantConfig.loadAllAssistants>(
  () => [],
);
const resolveCloudMock = mock<typeof assistantConfig.resolveCloud>(
  (entry) => entry.cloud,
);
const saveAssistantEntryMock = mock<typeof assistantConfig.saveAssistantEntry>(
  () => {},
);

mock.module("../lib/assistant-config", () => ({
  ...realAssistantConfig,
  findAssistantByName: findAssistantByNameMock,
  getActiveAssistant: getActiveAssistantMock,
  loadAllAssistants: loadAllAssistantsMock,
  resolveCloud: resolveCloudMock,
  saveAssistantEntry: saveAssistantEntryMock,
}));

const createBackupMock = mock<typeof backupOps.createBackup>(
  async () => "/tmp/local-pre-upgrade.vbundle",
);
const pruneOldBackupsMock = mock<typeof backupOps.pruneOldBackups>(() => {});
const restoreBackupMock = mock<typeof backupOps.restoreBackup>(
  async () => true,
);

mock.module("../lib/backup-ops.js", () => ({
  ...realBackupOps,
  createBackup: createBackupMock,
  pruneOldBackups: pruneOldBackupsMock,
  restoreBackup: restoreBackupMock,
}));

const generateLocalSigningKeyMock = mock<typeof local.generateLocalSigningKey>(
  () => "generated-local-secret",
);
const ensureLocalRuntimeMock = mock<typeof local.ensureLocalRuntime>(
  (resources, version) => ({
    version,
    installDir: join(resources.instanceDir, ".vellum", "runtime", version),
  }),
);
const startLocalDaemonMock = mock<typeof local.startLocalDaemon>(
  async () => {},
);
const startGatewayMock = mock<typeof local.startGateway>(
  async () => "http://127.0.0.1:7830",
);
const stopLocalProcessesMock = mock<typeof local.stopLocalProcesses>(
  async () => {},
);

mock.module("../lib/local.js", () => ({
  ...realLocal,
  generateLocalSigningKey: generateLocalSigningKeyMock,
  ensureLocalRuntime: ensureLocalRuntimeMock,
  startLocalDaemon: startLocalDaemonMock,
  startGateway: startGatewayMock,
  stopLocalProcesses: stopLocalProcessesMock,
}));

const loopbackSafeFetchMock = mock<typeof loopbackFetch.loopbackSafeFetch>(
  async () =>
    ({
      ok: true,
      json: async () => ({
        version: "v0.8.11",
        migrations: {
          dbVersion: 12,
          lastWorkspaceMigrationId: "011-test",
        },
      }),
    }) as Response,
);

mock.module("../lib/loopback-fetch.js", () => ({
  ...realLoopbackFetch,
  loopbackSafeFetch: loopbackSafeFetchMock,
}));

const maybeStartNgrokTunnelMock = mock<typeof ngrok.maybeStartNgrokTunnel>(
  async () => null,
);

mock.module("../lib/ngrok.js", () => ({
  ...realNgrok,
  maybeStartNgrokTunnel: maybeStartNgrokTunnelMock,
}));

const broadcastUpgradeEventMock = mock<
  typeof upgradeLifecycle.broadcastUpgradeEvent
>(async () => {});
const commitWorkspaceViaGatewayMock = mock<
  typeof upgradeLifecycle.commitWorkspaceViaGateway
>(async () => {});
const waitForReadyMock = mock<typeof upgradeLifecycle.waitForReady>(
  async () => true,
);

mock.module("../lib/upgrade-lifecycle.js", () => ({
  ...realUpgradeLifecycle,
  broadcastUpgradeEvent: broadcastUpgradeEventMock,
  commitWorkspaceViaGateway: commitWorkspaceViaGatewayMock,
  waitForReady: waitForReadyMock,
}));

const { targetVersionFromCli, upgrade } =
  await import("../commands/upgrade.js");

let tempDir: string;
let originalArgv: string[];
let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleWarnSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;
let exitSpy: ReturnType<typeof spyOn>;

function makeLocalEntry(): AssistantEntry {
  tempDir = mkdtempSync(join(tmpdir(), "vellum-upgrade-local-test-"));
  mkdirSync(join(tempDir, ".vellum"), { recursive: true });
  return {
    assistantId: "local-assistant",
    runtimeUrl: "http://lan.local:7830",
    localUrl: "http://127.0.0.1:7830",
    cloud: "local",
    resources: {
      instanceDir: tempDir,
      daemonPort: 7821,
      gatewayPort: 7830,
      qdrantPort: 6333,
      cesPort: 7822,
      signingKey: "existing-signing-key",
    },
    guardianBootstrapSecret: "existing-bootstrap-secret",
  };
}

beforeEach(() => {
  originalArgv = [...process.argv];
  tempDir = "";
  process.argv = [
    "bun",
    "vellum",
    "upgrade",
    "local-assistant",
    "--version",
    cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
  ];

  consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
    throw new Error(`process.exit(${code})`);
  });

  const entry = makeLocalEntry();
  findAssistantByNameMock.mockReset();
  findAssistantByNameMock.mockReturnValue(entry);
  getActiveAssistantMock.mockReset();
  getActiveAssistantMock.mockReturnValue("local-assistant");
  loadAllAssistantsMock.mockReset();
  loadAllAssistantsMock.mockReturnValue([entry]);
  resolveCloudMock.mockReset();
  resolveCloudMock.mockImplementation((target) => target.cloud);
  saveAssistantEntryMock.mockReset();
  createBackupMock.mockReset();
  createBackupMock.mockResolvedValue("/tmp/local-pre-upgrade.vbundle");
  pruneOldBackupsMock.mockReset();
  pruneOldBackupsMock.mockReturnValue(undefined);
  restoreBackupMock.mockReset();
  restoreBackupMock.mockResolvedValue(true);
  generateLocalSigningKeyMock.mockReset();
  generateLocalSigningKeyMock.mockReturnValue("generated-local-secret");
  ensureLocalRuntimeMock.mockReset();
  ensureLocalRuntimeMock.mockImplementation((resources, version) => ({
    version,
    installDir: join(resources.instanceDir, ".vellum", "runtime", version),
  }));
  startLocalDaemonMock.mockReset();
  startLocalDaemonMock.mockResolvedValue(undefined);
  startGatewayMock.mockReset();
  startGatewayMock.mockResolvedValue("http://127.0.0.1:7830");
  stopLocalProcessesMock.mockReset();
  stopLocalProcessesMock.mockResolvedValue(undefined);
  loopbackSafeFetchMock.mockReset();
  loopbackSafeFetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      version: "v0.8.11",
      migrations: {
        dbVersion: 12,
        lastWorkspaceMigrationId: "011-test",
      },
    }),
  } as Response);
  maybeStartNgrokTunnelMock.mockReset();
  maybeStartNgrokTunnelMock.mockResolvedValue(null);
  broadcastUpgradeEventMock.mockReset();
  broadcastUpgradeEventMock.mockResolvedValue(undefined);
  commitWorkspaceViaGatewayMock.mockReset();
  commitWorkspaceViaGatewayMock.mockResolvedValue(undefined);
  waitForReadyMock.mockReset();
  waitForReadyMock.mockResolvedValue(true);
});

afterEach(() => {
  process.argv = originalArgv;
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  mock.module("../lib/assistant-config", () => realAssistantConfig);
  mock.module("../lib/backup-ops.js", () => realBackupOps);
  mock.module("../lib/local.js", () => realLocal);
  mock.module("../lib/loopback-fetch.js", () => realLoopbackFetch);
  mock.module("../lib/ngrok.js", () => realNgrok);
  mock.module("../lib/upgrade-lifecycle.js", () => realUpgradeLifecycle);
});

describe("vellum upgrade local", () => {
  test("uses explicit target versions as-is", async () => {
    const resolveLatest = mock(async () => "v0.9.9");

    await expect(
      targetVersionFromCli(
        "v0.8.12",
        "0.10.0-local.20260622155324.21c18fa3b3",
        resolveLatest,
      ),
    ).resolves.toBe("v0.8.12");
    expect(resolveLatest).not.toHaveBeenCalled();
  });

  test("defaults published CLI builds to the CLI version", async () => {
    const resolveLatest = mock(async () => "v0.9.9");

    await expect(
      targetVersionFromCli(null, "0.10.0", resolveLatest),
    ).resolves.toBe("v0.10.0");
    expect(resolveLatest).not.toHaveBeenCalled();
  });

  test("defaults local CLI builds to the latest stable runtime", async () => {
    const resolveLatest = mock(async () => "v0.9.9");

    await expect(
      targetVersionFromCli(
        null,
        "0.10.0-local.20260622155324.21c18fa3b3",
        resolveLatest,
      ),
    ).resolves.toBe("v0.9.9");
    expect(resolveLatest).toHaveBeenCalledTimes(1);
  });

  test("restarts local assistant processes and records upgrade lifecycle", async () => {
    await upgrade();

    expect(loopbackSafeFetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830/healthz?include=migrations",
      expect.any(Object),
    );
    expect(createBackupMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      "local-assistant",
      expect.objectContaining({
        prefix: "local-assistant-pre-upgrade",
      }),
    );
    expect(saveAssistantEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        previousVersion: "v0.8.11",
        previousDbMigrationVersion: 12,
        previousWorkspaceMigrationId: "011-test",
        preUpgradeBackupPath: "/tmp/local-pre-upgrade.vbundle",
      }),
    );
    expect(stopLocalProcessesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceDir: tempDir,
        runtimeVersion: cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
      }),
    );
    expect(ensureLocalRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ instanceDir: tempDir }),
      cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
      { force: false },
    );
    expect(startLocalDaemonMock).toHaveBeenCalledWith(
      false,
      expect.objectContaining({
        instanceDir: tempDir,
        runtimeVersion: cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
      }),
      { signingKey: "existing-signing-key" },
    );
    expect(startGatewayMock).toHaveBeenCalledWith(
      false,
      expect.objectContaining({
        instanceDir: tempDir,
        runtimeVersion: cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
      }),
      {
        signingKey: "existing-signing-key",
        bootstrapSecret: "existing-bootstrap-secret",
      },
    );
    expect(maybeStartNgrokTunnelMock).toHaveBeenCalledWith(
      7830,
      join(tempDir, ".vellum", "workspace"),
    );
    expect(waitForReadyMock).toHaveBeenCalledWith("http://127.0.0.1:7830");
    expect(commitWorkspaceViaGatewayMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      "local-assistant",
      expect.stringContaining("topology: local"),
    );
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain("upgraded to");
  });

  test("skips restart when the local assistant is already on the target version", async () => {
    loopbackSafeFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        version: cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
      }),
    } as Response);

    await upgrade();

    expect(stopLocalProcessesMock).not.toHaveBeenCalled();
    expect(ensureLocalRuntimeMock).not.toHaveBeenCalled();
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain("Already on");
  });
});
