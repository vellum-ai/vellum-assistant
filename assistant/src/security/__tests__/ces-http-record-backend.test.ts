import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import * as envRegistry from "../../config/env-registry.js";
import {
  CesHttpRecordBackend,
  createCesHttpRecordBackendIfConfigured,
} from "../ces-http-record-backend.js";

const ORIGINAL_URL = process.env.CES_CREDENTIAL_URL;
const ORIGINAL_TOKEN = process.env.CES_SERVICE_TOKEN;

function restoreCesHttpEnv(): void {
  if (ORIGINAL_URL === undefined) {
    delete process.env.CES_CREDENTIAL_URL;
  } else {
    process.env.CES_CREDENTIAL_URL = ORIGINAL_URL;
  }
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.CES_SERVICE_TOKEN;
  } else {
    process.env.CES_SERVICE_TOKEN = ORIGINAL_TOKEN;
  }
}

function fakeHttpClient(options: {
  listRecords: () => Promise<{
    records: Array<{ account: string; record: CredentialRecord }>;
    unreachable: boolean;
  }>;
}) {
  return {
    getRecord: async () => ({ record: undefined, unreachable: false }),
    setRecord: async () => false,
    deleteRecord: async () => "error" as const,
    listRecords: options.listRecords,
    bulkSetRecords: async (records: Array<{ account: string }>) =>
      records.map((entry) => ({ account: entry.account, ok: false })),
  };
}

describe("CES HTTP credential record backend", () => {
  afterEach(() => {
    restoreCesHttpEnv();
  });

  test("factory returns null when the assistant is not containerized", () => {
    const spy = spyOn(envRegistry, "getIsContainerized").mockReturnValue(false);
    process.env.CES_CREDENTIAL_URL = "http://ces-container:8090";
    process.env.CES_SERVICE_TOKEN = "token-123";
    try {
      expect(createCesHttpRecordBackendIfConfigured()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test("factory returns null when CES_CREDENTIAL_URL is unset", () => {
    const spy = spyOn(envRegistry, "getIsContainerized").mockReturnValue(true);
    delete process.env.CES_CREDENTIAL_URL;
    process.env.CES_SERVICE_TOKEN = "token-123";
    try {
      expect(createCesHttpRecordBackendIfConfigured()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test("factory returns null when CES_SERVICE_TOKEN is unset", () => {
    const spy = spyOn(envRegistry, "getIsContainerized").mockReturnValue(true);
    process.env.CES_CREDENTIAL_URL = "http://ces-container:8090";
    delete process.env.CES_SERVICE_TOKEN;
    try {
      expect(createCesHttpRecordBackendIfConfigured()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test("factory returns a backend when containerized with CES HTTP env", () => {
    const spy = spyOn(envRegistry, "getIsContainerized").mockReturnValue(true);
    process.env.CES_CREDENTIAL_URL = "http://ces-container:8090";
    process.env.CES_SERVICE_TOKEN = "token-123";
    try {
      const backend = createCesHttpRecordBackendIfConfigured();
      expect(backend?.name).toBe("ces-http");
      expect(backend?.isAvailable()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("list returns records when HTTP reports a reachable catalog", async () => {
    const record: CredentialRecord = {
      credentialId: "cred-http",
      service: "github",
      field: "token",
      allowedTools: ["bash"],
      allowedDomains: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const backend = new CesHttpRecordBackend(
      fakeHttpClient({
        listRecords: async () => ({
          records: [{ account: "github:token", record }],
          unreachable: false,
        }),
      }),
    );

    const listed = await backend.list();
    expect(listed).toEqual([{ account: "github:token", record }]);
  });

  test("list returns an empty catalog when HTTP is reachable and empty", async () => {
    const backend = new CesHttpRecordBackend(
      fakeHttpClient({
        listRecords: async () => ({ records: [], unreachable: false }),
      }),
    );

    const listed = await backend.list();
    expect(listed).toEqual([]);
  });

  test("list returns null when HTTP reports the vault unreachable", async () => {
    const backend = new CesHttpRecordBackend(
      fakeHttpClient({
        listRecords: async () => ({ records: [], unreachable: true }),
      }),
    );

    expect(await backend.list()).toBeNull();
  });
});
