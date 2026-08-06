import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { ACP_OAUTH_TOKEN_FIELD, ACP_SERVICE } from "../acp/acp-credentials.js";
import { credentialKey } from "../security/credential-key.js";

let secureKeyStore: Record<string, string | undefined> = {};

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => secureKeyStore[key],
  getSecureKeyResultAsync: async (key: string) => ({
    value: secureKeyStore[key],
    unreachable: false,
  }),
  setSecureKeyAsync: async (key: string, value: string) => {
    secureKeyStore[key] = value;
    return true;
  },
  deleteSecureKeyAsync: async (key: string) => {
    delete secureKeyStore[key];
    return "deleted";
  },
  getActiveBackendName: () => "test",
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: () => {},
  upsertCredentialMetadata: () => {},
  deleteCredentialMetadata: () => {},
}));

mock.module("../oauth/manual-token-connection.js", () => ({
  syncManualTokenConnection: async () => {},
}));

afterAll(() => {
  mock.restore();
});

import { BadRequestError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/secret-routes.js";

const addRoute = ROUTES.find(
  (r) => r.method === "POST" && r.endpoint === "secrets",
)!;

function addAcpOauthToken(value: string) {
  return addRoute.handler({
    body: {
      type: "credential",
      name: `${ACP_SERVICE}:${ACP_OAUTH_TOKEN_FIELD}`,
      value,
    },
  });
}

describe("secret routes ACP OAuth-token format guard", () => {
  beforeEach(() => {
    secureKeyStore = {};
  });

  test("rejects an Anthropic API key with a 400 and does not persist it", async () => {
    await expect(
      addAcpOauthToken("sk-ant-api03-not-an-oauth-token"),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(
      secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD)],
    ).toBeUndefined();
  });

  test("accepts a Claude OAuth token", async () => {
    const result = await addAcpOauthToken("sk-ant-oat01-valid-oauth-token");
    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(
      secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD)],
    ).toBe("sk-ant-oat01-valid-oauth-token");
  });
});
