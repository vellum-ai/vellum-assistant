import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { credentialKey } from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import {
  CesCredentialRecordStore,
  getCredentialRecordsPath,
} from "../records/credential-record-store.js";

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

describe("CesCredentialRecordStore", () => {
  test("round-trips a record by account key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ces-records-"));
    const store = new CesCredentialRecordStore(getCredentialRecordsPath(dir));
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
    const account = credentialKey("github", "token");

    expect(store.setByAccount(account, record)).toBe(true);
    expect(store.getByAccount(account)).toEqual(record);
    expect(store.list()).toEqual([{ account, record }]);
    expect(store.deleteByAccount(account)).toBe("deleted");
    expect(store.getByAccount(account)).toBeUndefined();
  });

  test("rejects an account that does not match the record", () => {
    const dir = mkdtempSync(join(tmpdir(), "ces-records-"));
    const store = new CesCredentialRecordStore(getCredentialRecordsPath(dir));
    expect(
      store.setByAccount(
        credentialKey("github", "token"),
        makeRecord("gitlab", "token"),
      ),
    ).toBe(false);
  });
});
