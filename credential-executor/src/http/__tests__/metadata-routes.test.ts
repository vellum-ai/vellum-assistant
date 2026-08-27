import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import { handleMetadataRoute } from "../metadata-routes.js";
import {
  initMetadataStore,
  resetMetadataStoreForTests,
} from "../../records/metadata-store.js";

const SERVICE_TOKEN = "test-metadata-token";

function makeRecord(): CredentialRecord {
  return {
    credentialId: "id-1",
    service: "github",
    field: "token",
    allowedTools: ["assistant_browser_fill_credential"],
    allowedDomains: ["github.com"],
    createdAt: 10,
    updatedAt: 20,
  };
}

function makeRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost:8090${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_TOKEN}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("credential metadata HTTP routes", () => {
  afterEach(() => {
    resetMetadataStoreForTests();
    delete process.env.CES_SERVICE_TOKEN;
  });

  test("put, get, list, and delete a record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ces-metadata-http-"));
    initMetadataStore(dir);
    process.env.CES_SERVICE_TOKEN = SERVICE_TOKEN;
    const account = "credential/github/token";
    const record = makeRecord();

    const put = await handleMetadataRoute(
      makeRequest("PUT", `/v1/metadata/${encodeURIComponent(account)}`, {
        record,
      }),
    );
    expect(put?.status).toBe(200);

    const get = await handleMetadataRoute(
      makeRequest("GET", `/v1/metadata/${encodeURIComponent(account)}`),
    );
    expect(get?.status).toBe(200);
    expect(await get!.json()).toEqual({ account, record });

    const list = await handleMetadataRoute(makeRequest("GET", "/v1/metadata"));
    expect(list?.status).toBe(200);
    expect(await list!.json()).toEqual({ records: [{ account, record }] });

    const del = await handleMetadataRoute(
      makeRequest("DELETE", `/v1/metadata/${encodeURIComponent(account)}`),
    );
    expect(del?.status).toBe(200);
  });

  test("rejects requests without a bearer token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ces-metadata-http-"));
    initMetadataStore(dir);
    process.env.CES_SERVICE_TOKEN = SERVICE_TOKEN;
    const res = await handleMetadataRoute(
      new Request("http://localhost:8090/v1/metadata", { method: "GET" }),
    );
    expect(res?.status).toBe(401);
  });
});
