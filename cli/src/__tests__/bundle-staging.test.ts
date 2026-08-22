import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantEntry } from "../lib/assistant-config.js";
import { restoreBackup } from "../lib/backup-ops.js";
import {
  bundleFileSizeBytes,
  formatBundleSizeMb,
  importStagedBundle,
  RESTORE_STAGING_DIRNAME,
  stageBundleForRestore,
  stagingTargetFromEntry,
} from "../lib/bundle-staging.js";
import * as guardianToken from "../lib/guardian-token.js";
import * as loopbackFetch from "../lib/loopback-fetch.js";
import * as stepRunner from "../lib/step-runner.js";

function makeEntry(overrides: Partial<AssistantEntry> = {}): AssistantEntry {
  return {
    assistantId: "assistant-123",
    runtimeUrl: "http://127.0.0.1:7831",
    cloud: "local",
    species: "vellum",
    hatchedAt: new Date().toISOString(),
    ...overrides,
  } as AssistantEntry;
}

let tmpRoot: string;
let fetchSpy: ReturnType<typeof spyOn<typeof loopbackFetch, "loopbackSafeFetch">>;
let execSpy: ReturnType<typeof spyOn<typeof stepRunner, "exec">>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "cli-bundle-staging-"));
  fetchSpy = spyOn(loopbackFetch, "loopbackSafeFetch");
  execSpy = spyOn(stepRunner, "exec").mockResolvedValue(undefined);
});

afterEach(() => {
  fetchSpy.mockRestore();
  execSpy.mockRestore();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("stagingTargetFromEntry", () => {
  test("returns docker staging for docker topology", () => {
    expect(stagingTargetFromEntry(makeEntry({ cloud: "docker" }))).toEqual({
      kind: "docker",
      assistantId: "assistant-123",
    });
  });

  test("returns local staging when instanceDir is present", () => {
    expect(
      stagingTargetFromEntry(
        makeEntry({
          cloud: "local",
          resources: {
            instanceDir: "/tmp/instance",
          } as AssistantEntry["resources"],
        }),
      ),
    ).toEqual({ kind: "local", instanceDir: "/tmp/instance" });
  });

  test("returns null for unknown topologies", () => {
    expect(
      stagingTargetFromEntry(makeEntry({ cloud: "custom", sshUser: "user" })),
    ).toBeNull();
  });
});

describe("stageBundleForRestore", () => {
  test("copies a host bundle into the local workspace staging directory", async () => {
    const instanceDir = join(tmpRoot, "instance");
    const hostBundle = join(tmpRoot, "backup.vbundle");
    writeFileSync(hostBundle, "bundle-bytes");

    const staged = await stageBundleForRestore(
      { kind: "local", instanceDir },
      hostBundle,
    );

    const dest = join(
      instanceDir,
      ".vellum",
      "workspace",
      staged.relativePath,
    );
    expect(staged.relativePath.startsWith(`${RESTORE_STAGING_DIRNAME}/`)).toBe(
      true,
    );
    expect(staged.relativePath.endsWith(".vbundle")).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("bundle-bytes");
    expect(execSpy).not.toHaveBeenCalled();

    await staged.cleanup();
    expect(existsSync(dest)).toBe(false);
  });

  test("copies a host bundle into the docker workspace via docker cp", async () => {
    const hostBundle = join(tmpRoot, "backup.vbundle");
    writeFileSync(hostBundle, "bundle-bytes");

    const staged = await stageBundleForRestore(
      { kind: "docker", assistantId: "assistant-123" },
      hostBundle,
    );

    expect(execSpy).toHaveBeenCalledWith("docker", [
      "exec",
      "assistant-123-assistant",
      "mkdir",
      "-p",
      `/workspace/${RESTORE_STAGING_DIRNAME}`,
    ]);
    expect(execSpy).toHaveBeenCalledWith("docker", [
      "cp",
      hostBundle,
      `assistant-123-assistant:/workspace/${staged.relativePath}`,
    ]);

    await staged.cleanup();
    expect(execSpy).toHaveBeenCalledWith("docker", [
      "exec",
      "assistant-123-assistant",
      "rm",
      "-f",
      `/workspace/${staged.relativePath}`,
    ]);
  });
});

describe("importStagedBundle", () => {
  test("returns a direct 200 assistant response", async () => {
    const payload = { success: true, summary: { total_files: 1 } };
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 }),
    );

    const response = await importStagedBundle(
      "http://127.0.0.1:7831",
      "token",
      `${RESTORE_STAGING_DIRNAME}/backup.vbundle`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7831/v1/migrations/import");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    });
    expect(init?.body).toBe(
      JSON.stringify({
        path: `${RESTORE_STAGING_DIRNAME}/backup.vbundle`,
      }),
    );
  });

  test("polls a 202 gateway job until complete", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = mock((fn: (...args: unknown[]) => void) =>
      realSetTimeout(fn, 0),
    );
    globalThis.setTimeout = timeoutSpy as unknown as typeof setTimeout;

    try {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ job_id: "job-1", status: "pending" }), {
            status: 202,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: "processing" }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              status: "complete",
              result: { success: true, summary: { total_files: 2 } },
            }),
            { status: 200 },
          ),
        );

      const response = await importStagedBundle(
        "http://127.0.0.1:7831",
        "token",
        `${RESTORE_STAGING_DIRNAME}/backup.vbundle`,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        summary: { total_files: 2 },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(String(fetchSpy.mock.calls[1][0])).toBe(
        "http://127.0.0.1:7831/v1/migrations/import/job-1/status",
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe("restoreBackup staged path", () => {
  test("stages a local bundle and posts JSON { path }", async () => {
    const instanceDir = join(tmpRoot, "instance");
    mkdirSync(join(instanceDir, ".vellum", "workspace"), { recursive: true });
    const backupPath = join(tmpRoot, "backup.vbundle");
    writeFileSync(backupPath, "bundle-bytes");

    const loadSpy = spyOn(guardianToken, "loadGuardianToken").mockReturnValue({
      accessToken: "local-token",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as ReturnType<typeof guardianToken.loadGuardianToken>);

    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    try {
      const ok = await restoreBackup(
        "http://127.0.0.1:7831",
        "assistant-123",
        backupPath,
        { kind: "local", instanceDir },
      );
      expect(ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const init = fetchSpy.mock.calls[0][1];
      expect(init?.headers).toMatchObject({
        "Content-Type": "application/json",
      });
      const posted = JSON.parse(String(init?.body)) as { path: string };
      expect(posted.path.startsWith(`${RESTORE_STAGING_DIRNAME}/`)).toBe(true);
    } finally {
      loadSpy.mockRestore();
    }
  });
});

describe("bundle size helpers", () => {
  test("formatBundleSizeMb reports two decimal megabytes", () => {
    expect(formatBundleSizeMb(1024 * 1024)).toBe("1.00");
    expect(bundleFileSizeBytes(join(tmpRoot, "missing.vbundle"))).toBe(0);
  });
});
