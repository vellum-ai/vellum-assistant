import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { SecureKeyBackend } from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import { importWorkspaceMetadataMigration } from "../migrations/003-import-workspace-metadata.js";
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

describe("003-import-workspace-metadata", () => {
  test("imports leftover workspace metadata without deleting the file", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ces-ws-"));
    const cesData = mkdtempSync(join(tmpdir(), "ces-data-"));
    const leftoverPath = join(workspace, "data", "credentials", "metadata.json");
    mkdirSync(join(workspace, "data", "credentials"), { recursive: true });
    writeFileSync(
      leftoverPath,
      JSON.stringify({
        version: 5,
        credentials: [
          makeRecord("vercel", "api_token", { allowedTools: ["publish_page"] }),
        ],
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
      const store = new CesMetadataStore(getMetadataPath(cesData));
      const imported = store.getByAccount("credential/vercel/api_token");
      expect(imported?.allowedTools).toEqual(["publish_page"]);
      expect(imported?.credentialId).toBe("id-vercel-api_token");
      expect(existsSync(leftoverPath)).toBe(true);
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

  test("keeps an existing CES record instead of overwriting it", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ces-ws-"));
    const cesData = mkdtempSync(join(tmpdir(), "ces-data-"));
    const leftoverPath = join(workspace, "data", "credentials", "metadata.json");
    mkdirSync(join(workspace, "data", "credentials"), { recursive: true });
    writeFileSync(
      leftoverPath,
      JSON.stringify({
        version: 5,
        credentials: [
          makeRecord("vercel", "api_token", { allowedTools: ["bash"] }),
        ],
      }),
    );
    const store = new CesMetadataStore(getMetadataPath(cesData));
    store.setByAccount(
      "credential/vercel/api_token",
      makeRecord("vercel", "api_token", {
        credentialId: "id-ces-newer",
        allowedTools: ["publish_page"],
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
      const kept = store.getByAccount("credential/vercel/api_token");
      expect(kept?.credentialId).toBe("id-ces-newer");
      expect(kept?.allowedTools).toEqual(["publish_page"]);
      expect(existsSync(leftoverPath)).toBe(true);
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
