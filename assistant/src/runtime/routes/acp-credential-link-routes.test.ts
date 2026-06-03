/**
 * Tests for POST /v1/acp/credentials/link — the in-pod route hosted users
 * (who have no shell) use to link their BYO ACP/dev credentials via
 * client → gateway → daemon.
 *
 * The key invariant under test: credential values are WRITE-ONLY over the
 * wire. The handler stores the secret in the SAME broker location
 * `prepare-agent-env.ts` reads (`credential/acp/<field>` in secure-keys,
 * with `allowedTools: ["acp_spawn"]` metadata) and NEVER echoes the value
 * back in the response.
 *
 * These tests use the REAL secure-keys backend and metadata store (the test
 * preload routes both into a per-process temp workspace with CES disabled),
 * so we assert the value is actually readable by the credential broker the
 * way `acp_spawn` would read it — and that it never leaks back in responses.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { credentialKey } from "../../security/credential-key.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
} from "../../security/secure-keys.js";
import {
  deleteCredentialMetadata,
  getCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import { ROUTES } from "./acp-routes.js";

const LINKABLE_FIELDS = [
  "claude_oauth_token",
  "anthropic_api_key",
  "openai_api_key",
  "git_token",
] as const;

function getLinkHandler() {
  const route = ROUTES.find(
    (r) => r.endpoint === "acp/credentials/link" && r.method === "POST",
  );
  if (!route) throw new Error("acp/credentials/link route not registered");
  return route.handler;
}

async function clearLinkedCredentials() {
  for (const field of LINKABLE_FIELDS) {
    await deleteSecureKeyAsync(credentialKey("acp", field));
    deleteCredentialMetadata("acp", field);
  }
}

beforeEach(async () => {
  await clearLinkedCredentials();
});

afterAll(async () => {
  await clearLinkedCredentials();
});

describe("POST /v1/acp/credentials/link", () => {
  test("is registered with a settings.write policy", () => {
    const route = ROUTES.find(
      (r) => r.endpoint === "acp/credentials/link" && r.method === "POST",
    );
    expect(route).toBeDefined();
    expect(route?.policy?.requiredScopes).toEqual(["settings.write"]);
  });

  test("stores the value under credential/acp/<field> with an acp_spawn-only policy", async () => {
    const handler = getLinkHandler();
    const result = await handler({
      body: { field: "claude_oauth_token", value: "token-abc123" },
    });

    // Readable where prepare-agent-env.ts / the broker reads it.
    expect(await getSecureKeyAsync(credentialKey("acp", "claude_oauth_token")))
      .toBe("token-abc123");
    // Scoped to the agent spawn path only.
    expect(
      getCredentialMetadata("acp", "claude_oauth_token")?.allowedTools,
    ).toEqual(["acp_spawn"]);
    expect(result).toEqual({ field: "claude_oauth_token", linked: true });
  });

  test("WRITE-ONLY: the response never echoes the credential value", async () => {
    const handler = getLinkHandler();
    const secret = "super-secret-value-xyz";
    const result = (await handler({
      body: { field: "anthropic_api_key", value: secret },
    })) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain(secret);
    // No scrubbed/preview field either — just field + linked.
    expect(Object.keys(result).sort()).toEqual(["field", "linked"]);
  });

  test("accepts all four linkable fields, each scoped to acp_spawn", async () => {
    const handler = getLinkHandler();
    for (const field of LINKABLE_FIELDS) {
      const result = await handler({ body: { field, value: `v-${field}` } });
      expect(result).toEqual({ field, linked: true });
      expect(await getSecureKeyAsync(credentialKey("acp", field))).toBe(
        `v-${field}`,
      );
      expect(getCredentialMetadata("acp", field)?.allowedTools).toEqual([
        "acp_spawn",
      ]);
    }
  });

  test("re-linking a field overwrites the value and re-asserts the acp_spawn policy", async () => {
    const handler = getLinkHandler();
    await handler({ body: { field: "git_token", value: "old" } });
    await handler({ body: { field: "git_token", value: "new" } });

    expect(await getSecureKeyAsync(credentialKey("acp", "git_token"))).toBe(
      "new",
    );
    expect(getCredentialMetadata("acp", "git_token")?.allowedTools).toEqual([
      "acp_spawn",
    ]);
  });

  test("rejects a field outside the allowlist without writing anything", async () => {
    const handler = getLinkHandler();
    await expect(
      handler({ body: { field: "session_token", value: "v" } }),
    ).rejects.toThrow("field must be one of");
    expect(getCredentialMetadata("acp", "session_token")).toBeUndefined();
  });

  test("rejects a missing field", async () => {
    const handler = getLinkHandler();
    await expect(handler({ body: { value: "v" } })).rejects.toThrow(
      "field is required",
    );
  });

  test("rejects a missing value", async () => {
    const handler = getLinkHandler();
    await expect(
      handler({ body: { field: "git_token" } }),
    ).rejects.toThrow("value is required");
    expect(
      await getSecureKeyAsync(credentialKey("acp", "git_token")),
    ).toBeFalsy();
  });
});
