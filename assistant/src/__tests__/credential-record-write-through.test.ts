import { afterEach, describe, expect, test } from "bun:test";

import { credentialKey } from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import type { CredentialRecordBackend } from "../security/ces-rpc-record-backend.js";
import {
  _setMetadataPath,
  persistCredentialMetadata,
  setCredentialRecordBackend,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";

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

describe("CES credential record write-through", () => {
  afterEach(() => {
    setCredentialRecordBackend(undefined);
    _setMetadataPath(null);
  });

  test("upsert write-through updates the CES backend", async () => {
    const backend = makeBackend();
    setCredentialRecordBackend(backend);

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

  test("test metadata path override skips CES write-through", async () => {
    const backend = makeBackend();
    setCredentialRecordBackend(backend);
    _setMetadataPath("/tmp/does-not-write-through-metadata.json");

    const created = upsertCredentialMetadata("github", "token", {
      allowedTools: ["bash"],
    });
    await persistCredentialMetadata(created);

    expect(backend.store.size).toBe(0);
  });
});
