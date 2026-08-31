import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { credentialKey } from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import type { CredentialRecordBackend } from "../security/ces-rpc-record-backend.js";
import {
  _ensureCesRecordsLoaded,
  _setMetadataPath,
  getCredentialMetadata,
  setCredentialRecordBackend,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import { getDataDir } from "../util/platform.js";

function leftoverPath(): string {
  return join(getDataDir(), "credentials", "metadata.json");
}

function writeLeftover(record: CredentialRecord): void {
  const path = leftoverPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 5,
      credentials: [record],
    }),
  );
}

function leftoverContents(): string {
  return readFileSync(leftoverPath(), "utf-8");
}

function makeBackend(): CredentialRecordBackend & {
  store: Map<string, CredentialRecord>;
  bulkSetCalls: number;
  listCalls: number;
} {
  const store = new Map<string, CredentialRecord>();
  const backend: CredentialRecordBackend & {
    store: Map<string, CredentialRecord>;
    bulkSetCalls: number;
    listCalls: number;
  } = {
    store,
    bulkSetCalls: 0,
    listCalls: 0,
    isAvailable: () => true,
    get: async (account) => store.get(account),
    set: async (account, record) => {
      store.set(account, record);
      return true;
    },
    delete: async (account) => {
      if (!store.has(account)) {
        return "not-found";
      }
      store.delete(account);
      return "deleted";
    },
    list: async () => {
      backend.listCalls += 1;
      return [...store.entries()].map(([account, record]) => ({
        account,
        record,
      }));
    },
    bulkSet: async (records) => {
      backend.bulkSetCalls += 1;
      for (const { account, record } of records) {
        store.set(account, record);
      }
      return records.map((entry) => ({ account: entry.account, ok: true }));
    },
  };
  return backend;
}

describe("CES credential record cache", () => {
  beforeEach(() => {
    setCredentialRecordBackend(undefined);
    _setMetadataPath(null);
    const leftover = leftoverPath();
    if (existsSync(leftover)) {
      rmSync(leftover, { force: true });
    }
  });

  afterEach(() => {
    setCredentialRecordBackend(undefined);
    _setMetadataPath(null);
    const leftover = leftoverPath();
    if (existsSync(leftover)) {
      rmSync(leftover, { force: true });
    }
  });

  test("first catalog read lazy-loads CES records into the in-process cache", async () => {
    const backend = makeBackend();
    const record: CredentialRecord = {
      credentialId: "cred-1",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    };
    backend.store.set(credentialKey("github", "token"), record);
    setCredentialRecordBackend(backend);
    expect(backend.listCalls).toBe(0);

    getCredentialMetadata("github", "token");
    await _ensureCesRecordsLoaded();
    expect(backend.listCalls).toBe(1);

    expect(getCredentialMetadata("github", "token")?.credentialId).toBe(
      "cred-1",
    );
    expect(getCredentialMetadata("github", "token")?.allowedTools).toEqual([
      "bash",
    ]);
    getCredentialMetadata("github", "token");
    await _ensureCesRecordsLoaded();
    expect(backend.listCalls).toBe(1);
  });

  test("lazy load leaves leftover metadata.json in place and ignores it", async () => {
    const leftoverRecord: CredentialRecord = {
      credentialId: "cred-leftover",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: ["github.com"],
      createdAt: 1,
      updatedAt: 2,
    };
    writeLeftover(leftoverRecord);
    const before = leftoverContents();

    const backend = makeBackend();
    backend.store.set(credentialKey("github", "token"), leftoverRecord);
    setCredentialRecordBackend(backend);

    getCredentialMetadata("github", "token");
    await _ensureCesRecordsLoaded();

    expect(existsSync(leftoverPath())).toBe(true);
    expect(leftoverContents()).toBe(before);
    expect(backend.bulkSetCalls).toBe(0);
    expect(getCredentialMetadata("github", "token")?.allowedTools).toEqual([
      "bash",
    ]);
  });

  test("lazy load ignores leftover metadata.json when CES list fails", async () => {
    const leftoverRecord: CredentialRecord = {
      credentialId: "cred-keep",
      service: "slack_channel",
      field: "bot_token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    };
    writeLeftover(leftoverRecord);

    const backend = makeBackend();
    backend.list = async () => null;
    setCredentialRecordBackend(backend);

    getCredentialMetadata("slack_channel", "bot_token");
    await _ensureCesRecordsLoaded();

    expect(existsSync(leftoverPath())).toBe(true);
    expect(backend.bulkSetCalls).toBe(0);
    expect(
      getCredentialMetadata("slack_channel", "bot_token"),
    ).toBeUndefined();
  });

  test("lazy load ignores leftover metadata.json when CES has no leftover accounts", async () => {
    const leftoverRecord: CredentialRecord = {
      credentialId: "cred-missing",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    };
    writeLeftover(leftoverRecord);

    const backend = makeBackend();
    setCredentialRecordBackend(backend);

    getCredentialMetadata("github", "token");
    await _ensureCesRecordsLoaded();

    expect(existsSync(leftoverPath())).toBe(true);
    expect(backend.store.size).toBe(0);
    expect(backend.bulkSetCalls).toBe(0);
    expect(getCredentialMetadata("github", "token")).toBeUndefined();
  });

  test("lazy load does not throw when CES isAvailable throws", async () => {
    const backend = makeBackend();
    backend.isAvailable = () => {
      throw new Error("CES boom");
    };
    setCredentialRecordBackend(backend);

    getCredentialMetadata("github", "token");
    await _ensureCesRecordsLoaded();
  });

  test("upsert write-throughs to CES without updating leftover metadata.json", async () => {
    const leftoverRecord: CredentialRecord = {
      credentialId: "cred-leftover",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    };
    writeLeftover(leftoverRecord);
    const leftoverBefore = leftoverContents();

    const backend = makeBackend();
    backend.store.set(credentialKey("github", "token"), leftoverRecord);
    setCredentialRecordBackend(backend);
    getCredentialMetadata("github", "token");
    await _ensureCesRecordsLoaded();
    expect(existsSync(leftoverPath())).toBe(true);

    const created = upsertCredentialMetadata("slack_channel", "bot_token", {
      allowedTools: ["bash"],
    });
    await Promise.resolve();

    expect(existsSync(leftoverPath())).toBe(true);
    expect(leftoverContents()).toBe(leftoverBefore);
    expect(
      backend.store.get(credentialKey("slack_channel", "bot_token"))
        ?.credentialId,
    ).toBe(created.credentialId);
    expect(getCredentialMetadata("slack_channel", "bot_token")?.allowedTools).toEqual(
      ["bash"],
    );
  });
});
