import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getLockfileData,
  isPairedLockfileEntry,
  renameLockfileAssistantIfPresent,
  replacePlatformAssistants,
  upsertLockfileAssistant,
  upsertRendererLockfileAssistant,
} from "./lockfile";

let dir: string;
let lockfilePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-test-"));
  lockfilePath = path.join(dir, "lockfile.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeOnDisk(value: unknown): void {
  fs.writeFileSync(lockfilePath, JSON.stringify(value, null, 2));
}

function readOnDisk(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(lockfilePath, "utf-8")) as Record<
    string,
    unknown
  >;
}

describe("getLockfileData", () => {
  test("returns the empty lockfile when no file exists", () => {
    const result = getLockfileData([lockfilePath]);
    expect(result).toEqual({
      ok: true,
      data: { assistants: [], activeAssistant: null },
      raw: { assistants: [], activeAssistant: null },
    });
  });

  test("validates and salvages a partially-malformed file", () => {
    writeOnDisk({
      activeAssistant: "asst_ok",
      assistants: [
        { assistantId: "asst_ok", cloud: "local", runtimeUrl: "http://a" },
        { cloud: "local", runtimeUrl: "http://b" }, // missing assistantId
      ],
    });

    const result = getLockfileData([lockfilePath]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assistants).toEqual([
        { assistantId: "asst_ok", cloud: "local", runtimeUrl: "http://a" },
      ]);
    }
  });

  test("salvages a legacy entry that predates cloud/runtimeUrl", () => {
    // An entry written by an older CLI: no `cloud`, and the runtime URL stored
    // under the legacy `localUrl` key rather than `runtimeUrl`. Only the
    // identity is guaranteed, so the entry must still be returned (the modeled
    // fields it lacks are simply absent on the wire value).
    writeOnDisk({
      activeAssistant: "asst_legacy",
      assistants: [
        { assistantId: "asst_legacy", localUrl: "http://127.0.0.1:7777" },
      ],
    });

    const result = getLockfileData([lockfilePath]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assistants).toEqual([
        { assistantId: "asst_legacy", cloud: "local" },
      ]);
      expect(result.data.activeAssistant).toBe("asst_legacy");
    }
  });

  test("surfaces a tunnel-recorded ingressUrl to the renderer", () => {
    // The exact read the "Pair a device" card relies on: `vellum tunnel` stamps
    // ingressUrl onto the entry, and the host read must carry it through.
    writeOnDisk({
      activeAssistant: "asst_1",
      assistants: [
        {
          assistantId: "asst_1",
          cloud: "local",
          runtimeUrl: "http://127.0.0.1:7777",
          ingressUrl: "https://tunnel.example.ts.net",
        },
      ],
    });

    const result = getLockfileData([lockfilePath]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assistants[0]?.ingressUrl).toBe(
        "https://tunnel.example.ts.net",
      );
    }
  });

  test("fails with status 500 on malformed JSON", () => {
    fs.writeFileSync(lockfilePath, "{ not json");
    const result = getLockfileData([lockfilePath]);
    expect(result).toEqual({ ok: false, status: 500 });
  });
});

// Hosts pass {paired} to getGuardianAccessToken so expired pairings get
// re-pair guidance instead of hatch/wake; this pins the classification.
describe("isPairedLockfileEntry", () => {
  test("classifies paired cloud entries and host pairing markers as paired", () => {
    writeOnDisk({
      assistants: [
        { assistantId: "paired-1", cloud: "paired" },
        { assistantId: "paired-marker", cloud: "local", paired: true },
        { assistantId: "local-1", cloud: "local" },
      ],
      activeAssistant: "local-1",
    });

    expect(isPairedLockfileEntry([lockfilePath], "paired-1")).toBe(true);
    expect(isPairedLockfileEntry([lockfilePath], "paired-marker")).toBe(true);
    expect(isPairedLockfileEntry([lockfilePath], "local-1")).toBe(false);
    expect(isPairedLockfileEntry([lockfilePath], "missing")).toBe(false);
  });

  test("an absent lockfile never classifies as paired", () => {
    expect(
      isPairedLockfileEntry([path.join(dir, "absent.json")], "paired-1"),
    ).toBe(false);
  });
});

describe("upsertLockfileAssistant", () => {
  test("rejects an assistant with no id", () => {
    const result = upsertLockfileAssistant(
      [lockfilePath],
      { cloud: "local" },
      undefined,
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Missing assistant.assistantId",
    });
  });

  test("preserves unknown on-disk fields written by a newer client", () => {
    // A newer writer added a top-level field and per-entry fields this build
    // does not model. Upserting an unrelated assistant must not drop them.
    writeOnDisk({
      schemaVersion: 99,
      activeAssistant: "asst_old",
      assistants: [
        {
          assistantId: "asst_old",
          cloud: "vellum",
          runtimeUrl: "http://old",
          futureField: "keep-me",
        },
      ],
    });

    const result = upsertLockfileAssistant(
      [lockfilePath],
      { assistantId: "asst_new", cloud: "local", runtimeUrl: "http://new" },
      "asst_new",
    );

    expect(result.ok).toBe(true);

    const onDisk = readOnDisk();
    expect(onDisk.schemaVersion).toBe(99);
    const assistants = onDisk.assistants as Array<Record<string, unknown>>;
    const old = assistants.find((a) => a.assistantId === "asst_old");
    expect(old?.futureField).toBe("keep-me");

    // The returned wire value is the validated shape (unknown fields stripped).
    if (result.ok) {
      expect(result.lockfile.activeAssistant).toBe("asst_new");
      const wireOld = result.lockfile.assistants.find(
        (a) => a.assistantId === "asst_old",
      );
      expect(wireOld).toEqual({
        assistantId: "asst_old",
        cloud: "vellum",
        runtimeUrl: "http://old",
      });
    }
  });

  test("merges fields into an existing entry", () => {
    writeOnDisk({
      activeAssistant: null,
      assistants: [
        { assistantId: "asst_1", cloud: "local", runtimeUrl: "http://a" },
      ],
    });

    upsertLockfileAssistant(
      [lockfilePath],
      { assistantId: "asst_1", name: "Renamed" },
      undefined,
    );

    const assistants = readOnDisk().assistants as Array<
      Record<string, unknown>
    >;
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      assistantId: "asst_1",
      cloud: "local",
      runtimeUrl: "http://a",
      name: "Renamed",
    });
  });

  test("a name-only payload preserves resources and on-disk secrets byte-for-byte", () => {
    const entry = {
      assistantId: "asst_1",
      cloud: "local",
      runtimeUrl: "http://a",
      name: "Old Name",
      resources: { gatewayPort: 7830, daemonPort: 7831, dataDir: "/tmp/x" },
      signingKey: "sk-on-disk-secret",
      bearerToken: "bt-on-disk-secret",
      guardianBootstrapSecret: "gb-on-disk-secret",
    };
    writeOnDisk({ activeAssistant: "asst_1", assistants: [entry] });

    const result = upsertLockfileAssistant(
      [lockfilePath],
      { assistantId: "asst_1", name: "Renamed" },
      undefined,
    );

    expect(result.ok).toBe(true);
    const assistants = readOnDisk().assistants as Array<
      Record<string, unknown>
    >;
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toEqual({ ...entry, name: "Renamed" });
  });

  test("preserves activeAssistant when no active id is provided", () => {
    writeOnDisk({
      activeAssistant: "asst_active",
      assistants: [
        {
          assistantId: "asst_active",
          cloud: "local",
          runtimeUrl: "http://active",
        },
        { assistantId: "asst_1", cloud: "local", runtimeUrl: "http://a" },
      ],
    });

    const result = upsertLockfileAssistant(
      [lockfilePath],
      { assistantId: "asst_1", name: "Renamed" },
      undefined,
    );

    expect(result.ok).toBe(true);
    expect(readOnDisk().activeAssistant).toBe("asst_active");
    if (result.ok) {
      expect(result.lockfile.activeAssistant).toBe("asst_active");
    }
  });
});

describe("renameLockfileAssistantIfPresent", () => {
  const entry = {
    assistantId: "asst_1",
    cloud: "local",
    runtimeUrl: "http://a",
    name: "Old Name",
    resources: { gatewayPort: 7830, daemonPort: 7831, dataDir: "/tmp/x" },
    signingKey: "sk-on-disk-secret",
    bearerToken: "bt-on-disk-secret",
  };

  test("renames the entry preserving resources, secrets, and activeAssistant", () => {
    writeOnDisk({
      activeAssistant: "asst_other",
      assistants: [entry, { assistantId: "asst_other", cloud: "local" }],
    });

    const result = renameLockfileAssistantIfPresent(
      [lockfilePath],
      "asst_1",
      "Renamed",
    );

    expect(result.ok).toBe(true);
    const onDisk = readOnDisk();
    expect(onDisk.activeAssistant).toBe("asst_other");
    const assistants = onDisk.assistants as Array<Record<string, unknown>>;
    expect(assistants).toEqual([
      { ...entry, name: "Renamed" },
      { assistantId: "asst_other", cloud: "local" },
    ]);
  });

  test("refuses a missing entry without writing the file", () => {
    const result = renameLockfileAssistantIfPresent(
      [lockfilePath],
      "asst_gone",
      "Renamed",
    );

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "No lockfile entry for this assistant",
    });
    expect(fs.existsSync(lockfilePath)).toBe(false);
  });

  test("refuses when the id names another process's retired entry", () => {
    writeOnDisk({ activeAssistant: null, assistants: [entry] });
    const before = fs.readFileSync(lockfilePath, "utf-8");

    const result = renameLockfileAssistantIfPresent(
      [lockfilePath],
      "asst_retired",
      "Renamed",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(before);
  });

  test("refuses a corrupt on-disk file without clobbering it", () => {
    fs.writeFileSync(lockfilePath, "{ not json");

    const result = renameLockfileAssistantIfPresent(
      [lockfilePath],
      "asst_1",
      "Renamed",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
    }
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe("{ not json");
  });

  test("refuses non-object JSON on disk without clobbering it", () => {
    for (const raw of ["null", "[]", '"text"', "7"]) {
      fs.writeFileSync(lockfilePath, raw);

      const result = renameLockfileAssistantIfPresent(
        [lockfilePath],
        "asst_1",
        "Renamed",
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(409);
      }
      expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(raw);
    }
  });

  test("an already-equal name succeeds without rewriting the file", () => {
    // Compact formatting: any rewrite would re-indent and change the bytes.
    fs.writeFileSync(
      lockfilePath,
      JSON.stringify({ activeAssistant: null, assistants: [entry] }),
    );
    const before = fs.readFileSync(lockfilePath, "utf-8");

    const result = renameLockfileAssistantIfPresent(
      [lockfilePath],
      "asst_1",
      "Old Name",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lockfile.assistants[0]?.name).toBe("Old Name");
      expect(result.lockfile.assistants[0]).not.toHaveProperty("signingKey");
    }
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(before);
  });

  test("rejects a missing id or name without touching disk", () => {
    writeOnDisk({ activeAssistant: null, assistants: [entry] });
    const before = fs.readFileSync(lockfilePath, "utf-8");

    expect(renameLockfileAssistantIfPresent([lockfilePath], "", "N").ok).toBe(
      false,
    );
    expect(
      renameLockfileAssistantIfPresent([lockfilePath], "asst_1", "").ok,
    ).toBe(false);
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(before);
  });
});

describe("lockfile writers under lock contention", () => {
  const entry = {
    assistantId: "asst_1",
    cloud: "local",
    runtimeUrl: "http://a",
    name: "Old Name",
  };

  function holdLock(): string {
    const lockDir = `${lockfilePath}.lock`;
    fs.mkdirSync(lockDir);
    return lockDir;
  }

  test("rename refuses with 423 and leaves the file untouched", () => {
    writeOnDisk({ activeAssistant: null, assistants: [entry] });
    const before = fs.readFileSync(lockfilePath, "utf-8");
    holdLock();

    const result = renameLockfileAssistantIfPresent(
      [lockfilePath],
      "asst_1",
      "Renamed",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(423);
    }
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(before);
  });

  test("upsert refuses with 423 and leaves the file untouched", () => {
    writeOnDisk({ activeAssistant: null, assistants: [entry] });
    const before = fs.readFileSync(lockfilePath, "utf-8");
    holdLock();

    const result = upsertLockfileAssistant(
      [lockfilePath],
      { assistantId: "asst_2", cloud: "local" },
      undefined,
    );

    expect(result).toMatchObject({ ok: false, status: 423 });
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(before);
  });

  test("platform replace refuses with 423 and leaves the file untouched", () => {
    writeOnDisk({ activeAssistant: null, assistants: [entry] });
    const before = fs.readFileSync(lockfilePath, "utf-8");
    holdLock();

    const result = replacePlatformAssistants(
      [lockfilePath],
      [{ assistantId: "asst_p", cloud: "vellum", runtimeUrl: "http://p" }],
    );

    expect(result).toMatchObject({ ok: false, status: 423 });
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(before);
  });

  test("a successful rename leaves no lock dir behind", () => {
    writeOnDisk({ activeAssistant: null, assistants: [entry] });

    const result = renameLockfileAssistantIfPresent(
      [lockfilePath],
      "asst_1",
      "Renamed",
    );

    expect(result.ok).toBe(true);
    expect(fs.existsSync(`${lockfilePath}.lock`)).toBe(false);
  });
});

describe("upsertRendererLockfileAssistant", () => {
  const paired = {
    assistantId: "paired-1",
    cloud: "paired",
    paired: true,
    runtimeUrl: "https://gateway.example.com",
    name: "Paired assistant",
  };

  test("rejects creating or reclassifying an entry as paired", () => {
    expect(
      upsertRendererLockfileAssistant([lockfilePath], paired, "paired-1"),
    ).toMatchObject({ ok: false, status: 403 });

    writeOnDisk({
      assistants: [{ assistantId: "local-1", cloud: "local" }],
      activeAssistant: "local-1",
    });
    expect(
      upsertRendererLockfileAssistant(
        [lockfilePath],
        {
          assistantId: "local-1",
          cloud: "paired",
          runtimeUrl: "https://gateway.example.com",
        },
        undefined,
      ),
    ).toMatchObject({ ok: false, status: 403 });
  });

  test("rejects retargeting or reclassifying an existing paired entry", () => {
    writeOnDisk({ assistants: [paired], activeAssistant: "paired-1" });

    expect(
      upsertRendererLockfileAssistant(
        [lockfilePath],
        { assistantId: "paired-1", runtimeUrl: "https://attacker.example.com" },
        undefined,
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      upsertRendererLockfileAssistant(
        [lockfilePath],
        { assistantId: "paired-1", cloud: "local" },
        undefined,
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(readOnDisk()).toEqual({
      assistants: [paired],
      activeAssistant: "paired-1",
    });
  });

  test("allows non-security updates and activation of an existing pairing", () => {
    writeOnDisk({ assistants: [paired], activeAssistant: null });

    const result = upsertRendererLockfileAssistant(
      [lockfilePath],
      {
        assistantId: "paired-1",
        cloud: "paired",
        runtimeUrl: "https://gateway.example.com",
        name: "Renamed pairing",
      },
      "paired-1",
    );

    expect(result.ok).toBe(true);
    expect(readOnDisk()).toEqual({
      assistants: [{ ...paired, name: "Renamed pairing" }],
      activeAssistant: "paired-1",
    });
  });
});

describe("replacePlatformAssistants", () => {
  test("rejects a renderer sync that tries to create a paired entry", () => {
    writeOnDisk({
      activeAssistant: "asst_local",
      assistants: [
        { assistantId: "asst_local", cloud: "local", runtimeUrl: "http://l" },
      ],
    });

    expect(
      replacePlatformAssistants(
        [lockfilePath],
        [
          {
            assistantId: "asst_local",
            cloud: "paired",
            paired: true,
            runtimeUrl: "https://attacker.example.com",
          },
        ],
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(readOnDisk()).toEqual({
      activeAssistant: "asst_local",
      assistants: [
        { assistantId: "asst_local", cloud: "local", runtimeUrl: "http://l" },
      ],
    });
  });

  test("replaces platform assistants while keeping local ones and unknown fields", () => {
    writeOnDisk({
      schemaVersion: 99,
      activeAssistant: "asst_local",
      assistants: [
        { assistantId: "asst_local", cloud: "local", runtimeUrl: "http://l" },
        {
          assistantId: "asst_old_platform",
          cloud: "vellum",
          runtimeUrl: "http://op",
        },
      ],
    });

    const result = replacePlatformAssistants(
      [lockfilePath],
      [
        {
          assistantId: "asst_new_platform",
          cloud: "vellum",
          runtimeUrl: "http://np",
        },
      ],
    );

    expect(result.ok).toBe(true);

    const onDisk = readOnDisk();
    expect(onDisk.schemaVersion).toBe(99);
    const ids = (onDisk.assistants as Array<Record<string, unknown>>).map(
      (a) => a.assistantId,
    );
    expect(ids).toEqual(["asst_local", "asst_new_platform"]);
  });

  test("a sync scoped to one org preserves another org's platform entries", () => {
    writeOnDisk({
      activeAssistant: null,
      assistants: [
        {
          assistantId: "asst_org_a",
          cloud: "vellum",
          organizationId: "org_a",
          runtimeUrl: "http://a",
        },
        {
          assistantId: "asst_org_b_old",
          cloud: "vellum",
          organizationId: "org_b",
          runtimeUrl: "http://bo",
        },
      ],
    });

    replacePlatformAssistants(
      [lockfilePath],
      [
        {
          assistantId: "asst_org_b_new",
          cloud: "vellum",
          organizationId: "org_b",
          runtimeUrl: "http://bn",
        },
      ],
      "org_b",
    );

    const ids = (readOnDisk().assistants as Array<Record<string, unknown>>).map(
      (a) => a.assistantId,
    );
    // Org A survives; Org B's stale entry is replaced by the new one.
    expect(ids).toEqual(["asst_org_a", "asst_org_b_new"]);
  });

  test("de-duplicates a legacy no-org entry that shares an id with the new list", () => {
    writeOnDisk({
      activeAssistant: null,
      assistants: [
        // Legacy platform entry with no organizationId, same id as the sync.
        { assistantId: "asst_dup", cloud: "vellum", runtimeUrl: "http://old" },
      ],
    });

    replacePlatformAssistants(
      [lockfilePath],
      [
        {
          assistantId: "asst_dup",
          cloud: "vellum",
          organizationId: "org_a",
          runtimeUrl: "http://new",
        },
      ],
      "org_a",
    );

    const assistants = readOnDisk().assistants as Array<
      Record<string, unknown>
    >;
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      assistantId: "asst_dup",
      organizationId: "org_a",
      runtimeUrl: "http://new",
    });
  });

  test("full-replaces all platform entries when no org is given (legacy)", () => {
    writeOnDisk({
      activeAssistant: null,
      assistants: [
        {
          assistantId: "asst_org_a",
          cloud: "vellum",
          organizationId: "org_a",
          runtimeUrl: "http://a",
        },
        {
          assistantId: "asst_org_b",
          cloud: "vellum",
          organizationId: "org_b",
          runtimeUrl: "http://b",
        },
      ],
    });

    replacePlatformAssistants(
      [lockfilePath],
      [
        {
          assistantId: "asst_new",
          cloud: "vellum",
          runtimeUrl: "http://np",
        },
      ],
    );

    const ids = (readOnDisk().assistants as Array<Record<string, unknown>>).map(
      (a) => a.assistantId,
    );
    expect(ids).toEqual(["asst_new"]);
  });

  test("local entries always survive an org-scoped sync", () => {
    writeOnDisk({
      activeAssistant: null,
      assistants: [
        { assistantId: "asst_local", cloud: "local", runtimeUrl: "http://l" },
        {
          assistantId: "asst_org_a",
          cloud: "vellum",
          organizationId: "org_a",
          runtimeUrl: "http://a",
        },
      ],
    });

    replacePlatformAssistants(
      [lockfilePath],
      [
        {
          assistantId: "asst_org_a_new",
          cloud: "vellum",
          organizationId: "org_a",
          runtimeUrl: "http://an",
        },
      ],
      "org_a",
    );

    const ids = (readOnDisk().assistants as Array<Record<string, unknown>>).map(
      (a) => a.assistantId,
    );
    expect(ids).toEqual(["asst_local", "asst_org_a_new"]);
  });

  test("keeps activeAssistant when it still resolves after an org-scoped sync", () => {
    writeOnDisk({
      activeAssistant: "asst_org_b_old",
      assistants: [
        {
          assistantId: "asst_org_b_old",
          cloud: "vellum",
          organizationId: "org_b",
          runtimeUrl: "http://bo",
        },
      ],
    });

    replacePlatformAssistants(
      [lockfilePath],
      [
        {
          assistantId: "asst_org_a",
          cloud: "vellum",
          organizationId: "org_a",
          runtimeUrl: "http://a",
        },
      ],
      "org_a",
    );

    // Org B's entry (and the active id pointing at it) survives the org-A sync.
    expect(readOnDisk().activeAssistant).toBe("asst_org_b_old");
  });

  test("clears activeAssistant when the active id no longer exists", () => {
    writeOnDisk({
      activeAssistant: "asst_old_platform",
      assistants: [
        {
          assistantId: "asst_old_platform",
          cloud: "vellum",
          runtimeUrl: "http://op",
        },
      ],
    });

    replacePlatformAssistants(
      [lockfilePath],
      [
        {
          assistantId: "asst_new_platform",
          cloud: "vellum",
          runtimeUrl: "http://np",
        },
      ],
    );

    expect(readOnDisk().activeAssistant).toBeNull();
  });
});
