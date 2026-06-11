import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getLockfileData,
  replacePlatformAssistants,
  upsertLockfileAssistant,
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
      expect(result.data.assistants).toEqual([{ assistantId: "asst_legacy" }]);
      expect(result.data.activeAssistant).toBe("asst_legacy");
    }
  });

  test("fails with status 500 on malformed JSON", () => {
    fs.writeFileSync(lockfilePath, "{ not json");
    const result = getLockfileData([lockfilePath]);
    expect(result).toEqual({ ok: false, status: 500 });
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
});

describe("replacePlatformAssistants", () => {
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

    const assistants = readOnDisk().assistants as Array<Record<string, unknown>>;
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
