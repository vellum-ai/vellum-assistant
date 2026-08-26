import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import {
  CesMetadataStore,
  getMetadataPath,
  parseCredentialAccount,
} from "../records/metadata-store.js";

function makeRecord(
  service: string,
  field: string,
  extras?: Partial<CredentialRecord>,
): CredentialRecord {
  return {
    credentialId: `id-${service}-${field}`,
    service,
    field,
    allowedTools: ["bash"],
    allowedDomains: [],
    createdAt: 1,
    updatedAt: 2,
    ...extras,
  };
}

describe("CesMetadataStore", () => {
  test("round-trips a record by account key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ces-metadata-"));
    const store = new CesMetadataStore(getMetadataPath(dir));
    const record = makeRecord("github", "token", {
      injectionTemplates: [
        {
          hostPattern: "github.com",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Bearer ",
        },
      ],
    });
    const account = "credential/github/token";

    expect(store.setByAccount(account, record)).toBe(true);
    expect(store.getByAccount(account)).toEqual(record);
    expect(store.list()).toEqual([{ account, record }]);
    expect(store.deleteByAccount(account)).toBe("deleted");
    expect(store.getByAccount(account)).toBeUndefined();
  });

  test("rejects an account that does not match the record", () => {
    const dir = mkdtempSync(join(tmpdir(), "ces-metadata-"));
    const store = new CesMetadataStore(getMetadataPath(dir));
    expect(
      store.setByAccount(
        "credential/github/token",
        makeRecord("gitlab", "token"),
      ),
    ).toBe(false);
  });

  test("writes metadata.json under the CES data root", () => {
    expect(getMetadataPath("/tmp/ces-data")).toBe("/tmp/ces-data/metadata.json");
  });
});

describe("parseCredentialAccount", () => {
  test("splits credential/{service}/{field}", () => {
    expect(parseCredentialAccount("credential/github/token")).toEqual({
      service: "github",
      field: "token",
    });
  });

  test("keeps slashes inside the service name", () => {
    expect(
      parseCredentialAccount("credential/integration:google/access_token"),
    ).toEqual({
      service: "integration:google",
      field: "access_token",
    });
  });

  test("rejects non-credential accounts", () => {
    expect(parseCredentialAccount("oauth/google/access")).toBeUndefined();
  });
});
