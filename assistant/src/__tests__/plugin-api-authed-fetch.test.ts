/**
 * Unit tests for plugin-api `authedFetch`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";
import type { CredentialMetadata } from "../tools/credentials/metadata-store.js";
import type { CredentialInjectionTemplate } from "../tools/credentials/policy-types.js";
import type { ResolvedCredential } from "../tools/credentials/resolve.js";
import { AUTHED_FETCH_CAPABILITY } from "../tools/credentials/tool-policy.js";

let resolveByIdResults = new Map<string, ResolvedCredential | undefined>();
let resolveByServiceFieldResults = new Map<
  string,
  ResolvedCredential | undefined
>();
let credentialMetadataList: CredentialMetadata[] = [];
let secureKeyValues = new Map<string, string | undefined>();

mock.module("../tools/credentials/resolve.js", () => ({
  resolveById: (credentialId: string) => resolveByIdResults.get(credentialId),
  resolveByServiceField: (service: string, field: string) =>
    resolveByServiceFieldResults.get(`${service}:${field}`),
  resolveCredentialRef: (ref: string) => {
    const byId = resolveByIdResults.get(ref);
    if (byId) {
      return byId;
    }
    const slashIndex = ref.indexOf("/");
    if (slashIndex <= 0 || slashIndex >= ref.length - 1) {
      return undefined;
    }
    if (ref.indexOf("/", slashIndex + 1) !== -1) {
      return undefined;
    }
    const service = ref.slice(0, slashIndex);
    const field = ref.slice(slashIndex + 1);
    return resolveByServiceFieldResults.get(`${service}:${field}`);
  },
  resolveForDomain: () => [],
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  listCredentialMetadata: () => credentialMetadataList,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: (account: string) =>
    Promise.resolve(secureKeyValues.get(account)),
}));

import { PLUGIN_API_EXPORTS } from "../embedded/plugin-api.js";
import { authedFetch, AuthedFetchError } from "../plugin-api/authed-fetch.js";
import * as pluginApi from "../plugin-api/index.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resolveByIdResults = new Map();
  resolveByServiceFieldResults = new Map();
  credentialMetadataList = [];
  secureKeyValues = new Map();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  // typeof fetch also requires Fetch.preconnect; tests only stub the call.
  globalThis.fetch = impl as unknown as typeof fetch;
}

function makeTemplate(
  hostPattern: string,
  headerName = "Authorization",
  valuePrefix = "Bearer ",
): CredentialInjectionTemplate {
  return { hostPattern, injectionType: "header", headerName, valuePrefix };
}

function makeResolved(
  credentialId: string,
  templates: CredentialInjectionTemplate[],
  options: {
    service?: string;
    field?: string;
    allowedTools?: string[];
  } = {},
): ResolvedCredential {
  const service = options.service ?? "acme";
  const field = options.field ?? "api_key";
  const allowedTools = options.allowedTools ?? [AUTHED_FETCH_CAPABILITY];
  const metadata: CredentialMetadata = {
    credentialId,
    service,
    field,
    allowedTools,
    allowedDomains: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    injectionTemplates: templates,
  };
  return {
    credentialId,
    service,
    field,
    storageKey: credentialKey(service, field),
    injectionTemplates: templates,
    metadata,
  };
}

function registerCredential(
  resolved: ResolvedCredential,
  secret: string,
): void {
  resolveByIdResults.set(resolved.credentialId, resolved);
  resolveByServiceFieldResults.set(
    `${resolved.service}:${resolved.field}`,
    resolved,
  );
  credentialMetadataList.push(resolved.metadata);
  secureKeyValues.set(resolved.storageKey, secret);
}

describe("authedFetch", () => {
  test("injects Authorization header from matching credential", async () => {
    const tpl = makeTemplate("api.acme.test");
    const resolved = makeResolved("cred-1", [tpl]);
    registerCredential(resolved, "secret-token");

    let capturedHeaders: Headers | undefined;
    stubFetch(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await authedFetch("https://api.acme.test/v1/items");
    expect(response.status).toBe(200);
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer secret-token");
  });

  test("overwrites a caller-provided header of the same name", async () => {
    const tpl = makeTemplate("api.acme.test");
    const resolved = makeResolved("cred-1", [tpl]);
    registerCredential(resolved, "secret-token");

    let capturedHeaders: Headers | undefined;
    stubFetch(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("", { status: 204 });
    });

    await authedFetch("https://api.acme.test/x", {
      headers: { Authorization: "Bearer caller-value" },
    });
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer secret-token");
  });

  test("denies when allowedTools does not include authedFetch", async () => {
    const tpl = makeTemplate("api.acme.test");
    const resolved = makeResolved("cred-1", [tpl], { allowedTools: ["bash"] });
    registerCredential(resolved, "secret-token");

    stubFetch(async () => {
      throw new Error("fetch must not be called");
    });

    await expect(authedFetch("https://api.acme.test/v1")).rejects.toMatchObject(
      {
        code: "POLICY_DENIED",
        name: "AuthedFetchError",
      },
    );
  });

  test("throws AMBIGUOUS_CREDENTIAL when two credentials match", async () => {
    const tpl = makeTemplate("*.acme.test");
    registerCredential(makeResolved("cred-a", [tpl], { field: "a" }), "a");
    registerCredential(
      makeResolved("cred-b", [tpl], { field: "b", service: "acme" }),
      "b",
    );

    stubFetch(async () => {
      throw new Error("fetch must not be called");
    });

    await expect(authedFetch("https://api.acme.test/v1")).rejects.toMatchObject(
      {
        code: "AMBIGUOUS_CREDENTIAL",
      },
    );
  });

  test("options.credential disambiguates among matches", async () => {
    const tpl = makeTemplate("*.acme.test");
    registerCredential(
      makeResolved("cred-a", [tpl], { field: "a" }),
      "token-a",
    );
    registerCredential(
      makeResolved("cred-b", [tpl], { field: "b", service: "acme" }),
      "token-b",
    );

    let capturedHeaders: Headers | undefined;
    stubFetch(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("", { status: 200 });
    });

    await authedFetch("https://api.acme.test/v1", undefined, {
      credential: "acme/b",
    });
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer token-b");
  });

  test("throws NO_CREDENTIAL when no template matches", async () => {
    const tpl = makeTemplate("other.test");
    registerCredential(makeResolved("cred-1", [tpl]), "secret");

    stubFetch(async () => {
      throw new Error("fetch must not be called");
    });

    await expect(
      authedFetch("https://api.acme.test/v1"),
    ).rejects.toBeInstanceOf(AuthedFetchError);
    await expect(authedFetch("https://api.acme.test/v1")).rejects.toMatchObject(
      {
        code: "NO_CREDENTIAL",
      },
    );
  });

  test("throws NO_HEADER_TEMPLATE when only query injection matches", async () => {
    const queryTpl: CredentialInjectionTemplate = {
      hostPattern: "api.acme.test",
      injectionType: "query",
      queryParamName: "key",
    };
    const resolved = makeResolved("cred-1", [queryTpl]);
    registerCredential(resolved, "secret");

    stubFetch(async () => {
      throw new Error("fetch must not be called");
    });

    await expect(
      authedFetch("https://api.acme.test/v1", undefined, {
        credential: "cred-1",
      }),
    ).rejects.toMatchObject({ code: "NO_HEADER_TEMPLATE" });
  });
});

describe("plugin-api authedFetch export", () => {
  test("authedFetch is exported as a runtime value", () => {
    expect(typeof pluginApi.authedFetch).toBe("function");
  });

  test("authedFetch is in the shim-rebound runtime surface", () => {
    expect(PLUGIN_API_EXPORTS).toContain("authedFetch");
  });
});
