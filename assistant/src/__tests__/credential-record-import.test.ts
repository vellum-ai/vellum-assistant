import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { credentialKey } from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import type { CredentialRecordBackend } from "../security/ces-rpc-record-backend.js";
import {
  _setMetadataPath,
  hydrateCredentialRecordsFromCes,
  setCredentialRecordBackend,
} from "../tools/credentials/metadata-store.js";
import { getDataDir } from "../util/platform.js";

function leftoverPath(): string {
  return join(getDataDir(), "credentials", "metadata.json");
}

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

describe("CES leftover metadata import", () => {
  afterEach(() => {
    setCredentialRecordBackend(undefined);
    _setMetadataPath(null);
    const leftover = leftoverPath();
    if (existsSync(leftover)) {
      rmSync(leftover, { force: true });
    }
  });

  test("copies leftover workspace rows into CES and keeps the file", async () => {
    const leftover = leftoverPath();
    mkdirSync(dirname(leftover), { recursive: true });
    writeFileSync(
      leftover,
      JSON.stringify({
        version: 5,
        credentials: [
          {
            credentialId: "id-github-token",
            service: "github",
            field: "token",
            allowedTools: ["bash"],
            allowedDomains: [],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    );

    const backend = makeBackend();
    setCredentialRecordBackend(backend);
    await hydrateCredentialRecordsFromCes();

    expect(
      backend.store.get(credentialKey("github", "token"))?.credentialId,
    ).toBe("id-github-token");
    expect(existsSync(leftover)).toBe(true);
    expect(readFileSync(leftover, "utf8")).toContain("id-github-token");
  });

  test("test metadata path override skips leftover import", async () => {
    const leftover = leftoverPath();
    mkdirSync(dirname(leftover), { recursive: true });
    writeFileSync(
      leftover,
      JSON.stringify({
        version: 5,
        credentials: [
          {
            credentialId: "id-skip",
            service: "github",
            field: "token",
            allowedTools: ["bash"],
            allowedDomains: [],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    );
    _setMetadataPath("/tmp/does-not-import-metadata.json");

    const backend = makeBackend();
    setCredentialRecordBackend(backend);
    await hydrateCredentialRecordsFromCes();

    expect(backend.store.size).toBe(0);
    expect(existsSync(leftover)).toBe(true);
  });
});
