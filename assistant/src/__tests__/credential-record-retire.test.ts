import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { credentialKey } from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import type { CredentialRecordBackend } from "../security/ces-rpc-record-backend.js";
import {
  _setMetadataPath,
  adoptCesCredentialRecords,
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
} {
  const store = new Map<string, CredentialRecord>();
  const backend: CredentialRecordBackend & {
    store: Map<string, CredentialRecord>;
    bulkSetCalls: number;
  } = {
    store,
    bulkSetCalls: 0,
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
    list: async () =>
      [...store.entries()].map(([account, record]) => ({ account, record })),
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

describe("CES credential record adopt", () => {
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

  test("adopt loads CES records into the in-process cache", async () => {
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

    await adoptCesCredentialRecords();

    expect(getCredentialMetadata("github", "token")?.credentialId).toBe(
      "cred-1",
    );
    expect(getCredentialMetadata("github", "token")?.allowedTools).toEqual([
      "bash",
    ]);
  });

  test("adopt leaves leftover metadata.json in place and ignores it", async () => {
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

    await adoptCesCredentialRecords();

    expect(existsSync(leftoverPath())).toBe(true);
    expect(leftoverContents()).toBe(before);
    expect(backend.bulkSetCalls).toBe(0);
    expect(getCredentialMetadata("github", "token")?.allowedTools).toEqual([
      "bash",
    ]);
  });

  test("adopt ignores leftover metadata.json when CES list fails", async () => {
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

    await adoptCesCredentialRecords();

    expect(existsSync(leftoverPath())).toBe(true);
    expect(backend.bulkSetCalls).toBe(0);
    expect(
      getCredentialMetadata("slack_channel", "bot_token"),
    ).toBeUndefined();
  });

  test("adopt ignores leftover metadata.json when CES has no leftover accounts", async () => {
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

    await adoptCesCredentialRecords();

    expect(existsSync(leftoverPath())).toBe(true);
    expect(backend.store.size).toBe(0);
    expect(backend.bulkSetCalls).toBe(0);
    expect(getCredentialMetadata("github", "token")).toBeUndefined();
  });

  test("adopt does not throw when CES isAvailable throws", async () => {
    const backend = makeBackend();
    backend.isAvailable = () => {
      throw new Error("CES boom");
    };
    setCredentialRecordBackend(backend);

    await adoptCesCredentialRecords();
  });

  test("upsert after adopt write-throughs to CES without updating leftover metadata.json", async () => {
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
    await adoptCesCredentialRecords();
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
