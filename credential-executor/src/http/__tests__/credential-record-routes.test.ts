import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { credentialKey } from "@vellumai/credential-storage";
import type { CredentialRecord } from "@vellumai/service-contracts/credential-rpc";

import { handleCredentialRecordRoute } from "../credential-record-routes.js";
import {
  CesCredentialRecordStore,
  getCredentialRecordsPath,
} from "../../records/credential-record-store.js";

const SERVICE_TOKEN = "test-record-token";

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

describe("credential record HTTP routes", () => {
  test("put, get, list, and delete a record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ces-record-http-"));
    const recordStore = new CesCredentialRecordStore(
      getCredentialRecordsPath(dir),
    );
    const deps = { recordStore, serviceToken: SERVICE_TOKEN };
    const account = credentialKey("github", "token");
    const record = makeRecord();

    const put = await handleCredentialRecordRoute(
      makeRequest(
        "PUT",
        `/v1/credential-records/${encodeURIComponent(account)}`,
        { record },
      ),
      deps,
    );
    expect(put?.status).toBe(200);

    const get = await handleCredentialRecordRoute(
      makeRequest(
        "GET",
        `/v1/credential-records/${encodeURIComponent(account)}`,
      ),
      deps,
    );
    expect(get?.status).toBe(200);
    expect(await get!.json()).toEqual({ account, record });

    const list = await handleCredentialRecordRoute(
      makeRequest("GET", "/v1/credential-records"),
      deps,
    );
    expect(list?.status).toBe(200);
    expect(await list!.json()).toEqual({ records: [{ account, record }] });

    const del = await handleCredentialRecordRoute(
      makeRequest(
        "DELETE",
        `/v1/credential-records/${encodeURIComponent(account)}`,
      ),
      deps,
    );
    expect(del?.status).toBe(200);
  });

  test("rejects requests without a bearer token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ces-record-http-"));
    const recordStore = new CesCredentialRecordStore(
      getCredentialRecordsPath(dir),
    );
    const res = await handleCredentialRecordRoute(
      new Request("http://localhost:8090/v1/credential-records", {
        method: "GET",
      }),
      { recordStore, serviceToken: SERVICE_TOKEN },
    );
    expect(res?.status).toBe(401);
  });
});
