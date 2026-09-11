import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { credentialKey } from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import type { CredentialRecordBackend } from "../security/ces-rpc-record-backend.js";
import {
  _ensureCesRecordsLoaded,
  _setHttpRecordBackendForTests,
  _setMetadataPath,
  getCredentialMetadata,
  listCredentialRecordsLive,
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

function makeBackend(
  name?: string,
): CredentialRecordBackend & {
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
    name,
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
    _setHttpRecordBackendForTests(null);
    _setMetadataPath(null);
    const leftover = leftoverPath();
    if (existsSync(leftover)) {
      rmSync(leftover, { force: true });
    }
  });

  afterEach(() => {
    setCredentialRecordBackend(undefined);
    _setHttpRecordBackendForTests(null);
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

  test("live catalog list returns CES records without the in-process cache", async () => {
    const backend = makeBackend();
    const record: CredentialRecord = {
      credentialId: "cred-live",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    };
    backend.store.set(credentialKey("github", "token"), record);
    setCredentialRecordBackend(backend);

    const live = await listCredentialRecordsLive();
    expect(live.unreachable).toBe(false);
    expect(live.records).toHaveLength(1);
    expect(live.records[0]?.credentialId).toBe("cred-live");
    expect(getCredentialMetadata("github", "token")).toBeUndefined();
  });

  test("live catalog list reports unreachable when CES list fails", async () => {
    const backend = makeBackend();
    backend.list = async () => null;
    setCredentialRecordBackend(backend);

    const live = await listCredentialRecordsLive();
    expect(live.unreachable).toBe(true);
    expect(live.records).toEqual([]);
  });

  test("live catalog list reports unreachable when no record backend is attached", async () => {
    const live = await listCredentialRecordsLive();
    expect(live.unreachable).toBe(true);
    expect(live.records).toEqual([]);
  });

  test("live catalog list fails over to CES HTTP when CES RPC list fails", async () => {
    const rpc = makeBackend("ces-rpc");
    rpc.list = async () => null;
    setCredentialRecordBackend(rpc);

    const http = makeBackend("ces-http");
    const record: CredentialRecord = {
      credentialId: "cred-http",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    };
    http.store.set(credentialKey("github", "token"), record);
    _setHttpRecordBackendForTests(http);

    const live = await listCredentialRecordsLive();
    expect(live.unreachable).toBe(false);
    expect(live.records).toHaveLength(1);
    expect(live.records[0]?.credentialId).toBe("cred-http");
    expect(http.listCalls).toBe(1);
  });

  test("live catalog list fails over to CES HTTP when CES RPC is unavailable", async () => {
    const rpc = makeBackend("ces-rpc");
    rpc.isAvailable = () => false;
    setCredentialRecordBackend(rpc);

    const http = makeBackend("ces-http");
    const record: CredentialRecord = {
      credentialId: "cred-http-down-rpc",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    };
    http.store.set(credentialKey("github", "token"), record);
    _setHttpRecordBackendForTests(http);

    const live = await listCredentialRecordsLive();
    expect(live.unreachable).toBe(false);
    expect(live.records[0]?.credentialId).toBe("cred-http-down-rpc");
  });

  test("live catalog list uses CES HTTP when no record backend is attached", async () => {
    const http = makeBackend("ces-http");
    const record: CredentialRecord = {
      credentialId: "cred-http-only",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    };
    http.store.set(credentialKey("github", "token"), record);
    _setHttpRecordBackendForTests(http);

    const live = await listCredentialRecordsLive();
    expect(live.unreachable).toBe(false);
    expect(live.records[0]?.credentialId).toBe("cred-http-only");
  });

  test("live catalog list does not fail over when CES RPC returns an empty catalog", async () => {
    const rpc = makeBackend("ces-rpc");
    setCredentialRecordBackend(rpc);

    const http = makeBackend("ces-http");
    http.store.set(credentialKey("github", "token"), {
      credentialId: "cred-http-ignored",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    });
    _setHttpRecordBackendForTests(http);

    const live = await listCredentialRecordsLive();
    expect(live.unreachable).toBe(false);
    expect(live.records).toEqual([]);
    expect(http.listCalls).toBe(0);
  });

  test("live catalog list does not fail over for a non-RPC record backend", async () => {
    const backend = makeBackend();
    backend.list = async () => null;
    setCredentialRecordBackend(backend);

    const http = makeBackend("ces-http");
    http.store.set(credentialKey("github", "token"), {
      credentialId: "cred-http-ignored",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    });
    _setHttpRecordBackendForTests(http);

    const live = await listCredentialRecordsLive();
    expect(live.unreachable).toBe(true);
    expect(live.records).toEqual([]);
    expect(http.listCalls).toBe(0);
  });

  test("live catalog list reports unreachable when CES RPC and HTTP both fail", async () => {
    const rpc = makeBackend("ces-rpc");
    rpc.list = async () => null;
    setCredentialRecordBackend(rpc);

    const http = makeBackend("ces-http");
    http.list = async () => null;
    _setHttpRecordBackendForTests(http);

    const live = await listCredentialRecordsLive();
    expect(live.unreachable).toBe(true);
    expect(live.records).toEqual([]);
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
