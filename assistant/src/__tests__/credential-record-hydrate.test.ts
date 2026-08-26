import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { credentialKey } from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import type { CredentialRecordBackend } from "../security/ces-rpc-record-backend.js";
import {
  _setMetadataPath,
  getCredentialMetadata,
  hydrateCredentialRecordsFromCes,
  persistCredentialMetadata,
  setCredentialRecordBackend,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import { getDataDir } from "../util/platform.js";

function makeBackend(): CredentialRecordBackend & {
  store: Map<string, CredentialRecord>;
} {
  const store = new Map<string, CredentialRecord>();
  return {
    store,
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
      for (const { account, record } of records) {
        store.set(account, record);
      }
      return records.map((entry) => ({ account: entry.account, ok: true }));
    },
  };
}

describe("CES credential record cache", () => {
  afterEach(() => {
    setCredentialRecordBackend(undefined);
    _setMetadataPath(null);
  });

  test("hydrate loads CES records into the in-process cache", async () => {
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

    await hydrateCredentialRecordsFromCes();

    expect(getCredentialMetadata("github", "token")?.credentialId).toBe(
      "cred-1",
    );
    expect(getCredentialMetadata("github", "token")?.allowedTools).toEqual([
      "bash",
    ]);
  });

  test("upsert write-through updates the CES backend", async () => {
    const backend = makeBackend();
    setCredentialRecordBackend(backend);
    await hydrateCredentialRecordsFromCes();

    const created = upsertCredentialMetadata("slack_channel", "bot_token", {
      allowedTools: ["bash"],
    });
    await persistCredentialMetadata(created);

    const stored = backend.store.get(
      credentialKey("slack_channel", "bot_token"),
    );
    expect(stored?.allowedTools).toEqual(["bash"]);
    expect(stored?.credentialId).toBe(created.credentialId);
  });

  test("hydrate imports leftover metadata.json into CES then deletes the file", async () => {
    const backend = makeBackend();
    setCredentialRecordBackend(backend);
    const leftover = join(getDataDir(), "credentials", "metadata.json");
    mkdirSync(dirname(leftover), { recursive: true });
    writeFileSync(
      leftover,
      JSON.stringify({
        version: 5,
        credentials: [
          {
            credentialId: "cred-leftover",
            service: "github",
            field: "token",
            allowedTools: ["bash"],
            allowedDomains: ["github.com"],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    );

    await hydrateCredentialRecordsFromCes();

    expect(existsSync(leftover)).toBe(false);
    expect(
      backend.store.get(credentialKey("github", "token"))?.credentialId,
    ).toBe("cred-leftover");
    expect(getCredentialMetadata("github", "token")?.allowedTools).toEqual([
      "bash",
    ]);
  });

  test("hydrate keeps leftover metadata.json when CES list fails", async () => {
    const backend = makeBackend();
    backend.list = async () => null;
    setCredentialRecordBackend(backend);
    const leftover = join(getDataDir(), "credentials", "metadata.json");
    mkdirSync(dirname(leftover), { recursive: true });
    writeFileSync(
      leftover,
      JSON.stringify({
        version: 5,
        credentials: [
          {
            credentialId: "cred-keep",
            service: "slack_channel",
            field: "bot_token",
            allowedTools: ["bash"],
            allowedDomains: [],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    );

    await hydrateCredentialRecordsFromCes();

    expect(existsSync(leftover)).toBe(true);
    expect(
      getCredentialMetadata("slack_channel", "bot_token")?.credentialId,
    ).toBe("cred-keep");
  });
});
