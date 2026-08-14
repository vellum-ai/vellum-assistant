import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { resetPluginActivationEligibilityCacheForTests } from "../plugins/activation-eligibility.js";
import {
  discoverExternalPluginWorkers,
  loadExternalPluginWorkers,
} from "../plugins/external-plugin-workers.js";
import {
  getActivePluginWorkerCount,
  resetPluginWorkerRunnerForTests,
  startPluginWorkers,
  stopPluginWorkers,
  waitForPluginWorkersIdleForTests,
} from "../plugins/plugin-worker-runner.js";
import { getWorkspaceDir } from "../util/platform.js";

const ROOT = join(
  tmpdir(),
  `vellum-plugin-worker-runner-test-${process.pid}-${Date.now()}`,
);

function createPlugin(pluginId: string): string {
  const pluginDir = join(ROOT, pluginId);
  mkdirSync(join(pluginDir, "workers"), { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({ name: `${pluginId}-package`, version: "1.0.0" }),
  );
  return pluginDir;
}

function writeWorker(pluginDir: string, name: string, source: string): void {
  writeFileSync(join(pluginDir, "workers", `${name}.ts`), source);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

beforeEach(() => {
  resetPluginActivationEligibilityCacheForTests();
});

afterEach(async () => {
  await resetPluginWorkerRunnerForTests();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("external plugin worker discovery", () => {
  test("prefers compiled workers and sorts by worker name", () => {
    const pluginDir = createPlugin("worker-discovery");
    writeWorker(pluginDir, "zeta", "export default () => {};\n");
    writeWorker(pluginDir, "alpha", "export default () => {};\n");
    writeFileSync(
      join(pluginDir, "workers", "alpha.js"),
      "export default () => {};\n",
    );

    const workers = discoverExternalPluginWorkers(pluginDir);

    expect(workers.map((worker) => worker.name)).toEqual(["alpha", "zeta"]);
    expect(workers[0]?.path.endsWith("alpha.js")).toBe(true);
    expect(
      workers.every((worker) => worker.pluginId === "worker-discovery"),
    ).toBe(true);
  });

  test("does not import workers for an incompatible plugin", async () => {
    const pluginDir = createPlugin("worker-incompatible");
    const importedMarker = join(pluginDir, "imported.txt");
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "worker-incompatible-package",
        version: "1.0.0",
        peerDependencies: { "@vellumai/plugin-api": "*" },
      }),
    );
    writeFileSync(
      join(pluginDir, "host-requirements.json"),
      JSON.stringify({
        schemaVersion: 1,
        requires: { "plugins.capability.not-implemented": "1.x" },
      }),
    );
    writeWorker(
      pluginDir,
      "side-effect",
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(importedMarker)}, "imported");\nexport default () => {};\n`,
    );

    await expect(loadExternalPluginWorkers(pluginDir)).rejects.toThrow(
      "is not eligible for workers",
    );
    expect(existsSync(importedMarker)).toBe(false);
  });
});

describe("plugin worker lifecycle", () => {
  test("migrates legacy durable state before initial recovery", async () => {
    const pluginId = "worker-storage-migration";
    const pluginDir = createPlugin(pluginId);
    const legacyDir = join(getWorkspaceDir(), "plugins-data", pluginId);
    rmSync(legacyDir, { recursive: true, force: true });
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "pending.txt"), "durable work");
    writeWorker(
      pluginDir,
      "outbox",
      `import { readFileSync, writeFileSync } from "node:fs";
export default function run(context) {
  const pending = readFileSync(context.pluginStorageDir + "/pending.txt", "utf8");
  writeFileSync(context.pluginStorageDir + "/recovered.txt", pending);
}
`,
    );

    await startPluginWorkers(pluginDir);
    await waitForPluginWorkersIdleForTests(pluginId);

    expect(existsSync(legacyDir)).toBe(false);
    expect(readFileSync(join(pluginDir, "data", "recovered.txt"), "utf8")).toBe(
      "durable work",
    );
  });

  test("runs once per activation and recovers durable work after restart", async () => {
    const pluginDir = createPlugin("worker-recovery");
    writeWorker(
      pluginDir,
      "outbox",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
export default async function run(context) {
  const path = context.pluginStorageDir + "/runs.txt";
  const prior = existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
  writeFileSync(path, String(prior + 1));
}
`,
    );

    const first = await startPluginWorkers(pluginDir);
    const duplicate = await startPluginWorkers(pluginDir);
    await waitForPluginWorkersIdleForTests("worker-recovery");

    expect(first).toEqual({
      pluginId: "worker-recovery",
      workerCount: 1,
      started: true,
    });
    expect(duplicate.started).toBe(false);
    expect(readFileSync(join(pluginDir, "data", "runs.txt"), "utf8")).toBe("1");

    await stopPluginWorkers("worker-recovery");
    await startPluginWorkers(pluginDir);
    await waitForPluginWorkersIdleForTests("worker-recovery");

    expect(readFileSync(join(pluginDir, "data", "runs.txt"), "utf8")).toBe("2");
  });

  test("passes host identity and honors an immediate wake request", async () => {
    const pluginDir = createPlugin("worker-context");
    writeWorker(
      pluginDir,
      "wake",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
export default function run(context) {
  const countPath = context.pluginStorageDir + "/count.txt";
  const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
  writeFileSync(countPath, String(count));
  writeFileSync(context.pluginStorageDir + "/identity.txt", context.pluginId);
  if (count === 1) {
    context.requestWake();
  }
}
`,
    );

    await startPluginWorkers(pluginDir);
    await waitForPluginWorkersIdleForTests("worker-context");

    expect(readFileSync(join(pluginDir, "data", "count.txt"), "utf8")).toBe(
      "2",
    );
    expect(readFileSync(join(pluginDir, "data", "identity.txt"), "utf8")).toBe(
      "worker-context",
    );
  });

  test("keeps a synchronous wake request ahead of a future wake", async () => {
    const pluginDir = createPlugin("worker-sync-wake");
    const countPath = join(pluginDir, "data", "count.txt");
    writeWorker(
      pluginDir,
      "wake",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
export default function run(context) {
  const countPath = context.pluginStorageDir + "/count.txt";
  const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
  writeFileSync(countPath, String(count));
  if (count === 1) {
    context.requestWake();
    return { nextWakeAt: Date.now() + 60_000 };
  }
}
`,
    );

    await startPluginWorkers(pluginDir);
    const deadline = Date.now() + 1_000;
    while (
      (!existsSync(countPath) || readFileSync(countPath, "utf8") !== "2") &&
      Date.now() <= deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }

    expect(readFileSync(countPath, "utf8")).toBe("2");
  });

  test("aborts an active worker when its plugin stops", async () => {
    const pluginDir = createPlugin("worker-stop");
    const startedPath = join(pluginDir, "data", "started.txt");
    const abortedPath = join(pluginDir, "data", "aborted.txt");
    writeWorker(
      pluginDir,
      "blocking",
      `import { writeFileSync } from "node:fs";
export default async function run(context) {
  writeFileSync(context.pluginStorageDir + "/started.txt", "yes");
  await new Promise((resolve) => {
    context.signal.addEventListener("abort", () => {
      writeFileSync(context.pluginStorageDir + "/aborted.txt", "yes");
      resolve();
    }, { once: true });
  });
}
`,
    );

    const startPromise = startPluginWorkers(pluginDir);
    await waitForFile(startedPath);
    expect(getActivePluginWorkerCount("worker-stop")).toBe(1);

    await stopPluginWorkers("worker-stop");
    await startPromise;

    expect(readFileSync(abortedPath, "utf8")).toBe("yes");
    expect(getActivePluginWorkerCount("worker-stop")).toBe(0);
  });

  test("rejects activation and stops sibling workers after initial failure", async () => {
    const pluginDir = createPlugin("worker-initial-failure");
    const abortedPath = join(pluginDir, "data", "sibling-aborted.txt");
    writeWorker(
      pluginDir,
      "blocking",
      `import { writeFileSync } from "node:fs";
export default async function run(context) {
  await new Promise((resolve) => {
    context.signal.addEventListener("abort", () => {
      writeFileSync(context.pluginStorageDir + "/sibling-aborted.txt", "yes");
      resolve();
    }, { once: true });
  });
}
`,
    );
    writeWorker(
      pluginDir,
      "failure",
      `export default function run() {
  throw new Error("initial recovery failed");
}
`,
    );

    await expect(startPluginWorkers(pluginDir)).rejects.toThrow(
      "initial recovery failed",
    );

    await waitForFile(abortedPath);
    expect(getActivePluginWorkerCount("worker-initial-failure")).toBe(0);
  });

  test("bounds initial recovery and aborts the timed-out plugin", async () => {
    const pluginDir = createPlugin("worker-initial-timeout");
    const abortedPath = join(pluginDir, "data", "aborted.txt");
    writeWorker(
      pluginDir,
      "blocking",
      `import { writeFileSync } from "node:fs";
export default async function run(context) {
  await new Promise((resolve) => {
    context.signal.addEventListener("abort", () => {
      writeFileSync(context.pluginStorageDir + "/aborted.txt", "yes");
      resolve();
    }, { once: true });
  });
}
`,
    );

    await expect(
      startPluginWorkers(pluginDir, { initialRunTimeoutMs: 10 }),
    ).rejects.toThrow("initial worker run timed out");

    await waitForFile(abortedPath);
    expect(getActivePluginWorkerCount("worker-initial-timeout")).toBe(0);
  });

  test("does not run a distant next wake immediately", async () => {
    const pluginDir = createPlugin("worker-distant-wake");
    writeWorker(
      pluginDir,
      "scheduled",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
export default function run(context) {
  const path = context.pluginStorageDir + "/runs.txt";
  const prior = existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
  writeFileSync(path, String(prior + 1));
  return { nextWakeAt: Date.now() + 2_147_483_647 + 60_000 };
}
`,
    );

    await startPluginWorkers(pluginDir);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    expect(readFileSync(join(pluginDir, "data", "runs.txt"), "utf8")).toBe("1");
  });

  test("prevents restart while a worker is still stopping", async () => {
    const pluginDir = createPlugin("worker-slow-stop");
    const startedPath = join(pluginDir, "data", "started.txt");
    const releasePath = join(pluginDir, "data", "release.txt");
    writeWorker(
      pluginDir,
      "blocking",
      `import { existsSync, writeFileSync } from "node:fs";
export default async function run(context) {
  writeFileSync(context.pluginStorageDir + "/started.txt", "yes");
  while (!existsSync(context.pluginStorageDir + "/release.txt")) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
`,
    );

    const startPromise = startPluginWorkers(pluginDir);
    await waitForFile(startedPath);
    await stopPluginWorkers("worker-slow-stop", { timeoutMs: 10 });

    await expect(startPluginWorkers(pluginDir)).rejects.toThrow(
      "workers are still stopping",
    );

    writeFileSync(releasePath, "yes");
    await startPromise;
    await waitForPluginWorkersIdleForTests("worker-slow-stop");
    await startPluginWorkers(pluginDir);
  });
});
