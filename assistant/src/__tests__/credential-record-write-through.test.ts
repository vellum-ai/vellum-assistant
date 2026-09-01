import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { credentialKey } from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import type { CredentialRecordBackend } from "../security/ces-rpc-record-backend.js";
import {
  _setMetadataPath,
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

describe("CES credential record write-through", () => {
  afterEach(() => {
    setCredentialRecordBackend(undefined);
    _setMetadataPath(null);
    const leftover = join(getDataDir(), "credentials", "metadata.json");
    if (existsSync(leftover)) {
      rmSync(leftover, { force: true });
    }
  });

  test("upsert write-through updates the CES backend", async () => {
    const backend = makeBackend();
    setCredentialRecordBackend(backend);

    const created = upsertCredentialMetadata("slack_channel", "bot_token", {
      allowedTools: ["bash"],
    });

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

    upsertCredentialMetadata("github", "token", {
      allowedTools: ["bash"],
    });

    expect(backend.store.size).toBe(0);
  });
});
