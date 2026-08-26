import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  credentialKey,
  type SecureKeyBackend,
} from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import { importWorkspaceMetadataMigration } from "../migrations/003-import-workspace-metadata.js";
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

describe("003-import-workspace-metadata", () => {
  test("imports workspace metadata.json into the CES record store", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ces-ws-"));
    const cesData = mkdtempSync(join(tmpdir(), "ces-data-"));
    const credDir = join(workspace, "data", "credentials");
    mkdirSync(credDir, { recursive: true });
    writeFileSync(
      join(credDir, "metadata.json"),
      JSON.stringify({
        version: 5,
        credentials: [makeRecord("vercel", "api_token", { allowedTools: ["publish_page"] })],
      }),
    );

    const prevWorkspace = process.env.VELLUM_WORKSPACE_DIR;
    const prevMode = process.env.CES_MODE;
    const prevData = process.env.CES_DATA_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspace;
    process.env.CES_MODE = "managed";
    process.env.CES_DATA_DIR = cesData;

    const unusedBackend: SecureKeyBackend = {
      get: async () => undefined,
      set: async () => true,
      delete: async () => "not-found",
      list: async () => [],
    };

    try {
      await importWorkspaceMetadataMigration.run(unusedBackend);
      const store = new CesCredentialRecordStore(
        getCredentialRecordsPath(cesData),
      );
      const imported = store.getByAccount(credentialKey("vercel", "api_token"));
      expect(imported?.allowedTools).toEqual(["publish_page"]);
      expect(imported?.credentialId).toBe("id-vercel-api_token");
    } finally {
      if (prevWorkspace === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = prevWorkspace;
      }
      if (prevMode === undefined) {
        delete process.env.CES_MODE;
      } else {
        process.env.CES_MODE = prevMode;
      }
      if (prevData === undefined) {
        delete process.env.CES_DATA_DIR;
      } else {
        process.env.CES_DATA_DIR = prevData;
      }
    }
  });
});
