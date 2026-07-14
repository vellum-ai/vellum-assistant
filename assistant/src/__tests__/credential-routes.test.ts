import { beforeEach, describe, expect, mock, test } from "bun:test";

import { BadRequestError } from "../runtime/routes/errors.js";
import type { CredentialMetadata } from "../tools/credentials/metadata-store.js";

// ---------------------------------------------------------------------------
// Mutable mock state (closed over by the mock factories below)
// ---------------------------------------------------------------------------

let secureStore: Map<string, string>;
let metadataStore: Map<string, CredentialMetadata>;
let syncedServices: string[];
let disconnectedProviders: string[];
let credentialIdCounter: number;

function metaKey(service: string, field: string): string {
  return `${service}:${field}`;
}

// ---------------------------------------------------------------------------
// Mocks for the routes' collaborators
// ---------------------------------------------------------------------------

mock.module("../runtime/auth/route-policy.js", () => ({
  ACTOR_PRINCIPALS: [],
}));

mock.module("../security/credential-key.js", () => ({
  credentialKey: (service: string, field: string) => `${service}:${field}`,
}));

mock.module("../security/secure-keys.js", () => ({
  setSecureKeyAsync: mock(async (key: string, value: string) => {
    secureStore.set(key, value);
    return true;
  }),
  getSecureKeyAsync: mock(async (key: string) => secureStore.get(key)),
  getSecureKeyResultAsync: mock(async (key: string) => ({
    value: secureStore.get(key),
    unreachable: false,
  })),
  deleteSecureKeyAsync: mock(async (key: string) =>
    secureStore.delete(key) ? "deleted" : "not-found",
  ),
  getActiveBackendName: () => "encrypted-store",
  getActiveBackendInfoAsync: mock(async () => ({ backend: "encrypted-store" })),
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: () => {},
  listCredentialMetadata: mock(() => Array.from(metadataStore.values())),
  getCredentialMetadata: mock((service: string, field: string) =>
    metadataStore.get(metaKey(service, field)),
  ),
  getCredentialMetadataById: mock((id: string) =>
    Array.from(metadataStore.values()).find((m) => m.credentialId === id),
  ),
  upsertCredentialMetadata: mock(
    (
      service: string,
      field: string,
      policy?: {
        allowedTools?: string[];
        usageDescription?: string;
        alias?: string | null;
      },
    ): CredentialMetadata => {
      const key = metaKey(service, field);
      const existing = metadataStore.get(key);
      const now = Date.now();
      const meta: CredentialMetadata = {
        credentialId: existing?.credentialId ?? `cred-${++credentialIdCounter}`,
        service,
        field,
        allowedTools: policy?.allowedTools ?? existing?.allowedTools ?? [],
        allowedDomains: existing?.allowedDomains ?? [],
        usageDescription:
          policy?.usageDescription ?? existing?.usageDescription,
        alias: policy?.alias ?? existing?.alias ?? undefined,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      metadataStore.set(key, meta);
      return meta;
    },
  ),
  deleteCredentialMetadata: mock((service: string, field: string) =>
    metadataStore.delete(metaKey(service, field)),
  ),
}));

mock.module("../oauth/manual-token-connection.js", () => ({
  syncManualTokenConnection: mock(async (service: string) => {
    syncedServices.push(service);
  }),
}));

mock.module("../oauth/oauth-store.js", () => ({
  listConnections: mock(() => []),
  getConnectionByProvider: mock(() => undefined),
  disconnectOAuthProvider: mock(async (provider: string) => {
    disconnectedProviders.push(provider);
    return "not-found";
  }),
}));

mock.module("../credential-execution/managed-catalog.js", () => ({
  fetchManagedCatalog: mock(async () => ({ ok: true, descriptors: [] })),
}));

import {
  _resetRevealSuccessRegistryForTest,
  currentRevealSuccessWatermark,
  revealedValueSince,
} from "../runtime/reveal-success-registry.js";
import { ROUTES } from "../runtime/routes/credential-routes.js";

const setRoute = ROUTES.find((r) => r.operationId === "credentials_set");
const listRoute = ROUTES.find((r) => r.operationId === "credentials_list");
const deleteRoute = ROUTES.find((r) => r.operationId === "credentials_delete");
const revealRoute = ROUTES.find((r) => r.operationId === "credentials_reveal");

type SetResponse = { credentialId: string; service: string; field: string };
type ListResponse = {
  credentials: Array<{
    service: string;
    field: string;
    scrubbedValue: string;
    hasSecret: boolean;
  }>;
  managedCredentials: unknown[];
};
type DeleteResponse = { service: string; field: string };

const SECRET_VALUE = "super-secret-token-value";

describe("credentials routes", () => {
  beforeEach(() => {
    secureStore = new Map();
    metadataStore = new Map();
    syncedServices = [];
    disconnectedProviders = [];
    credentialIdCounter = 0;
    _resetRevealSuccessRegistryForTest();
  });

  describe("credentials_reveal", () => {
    test("a local-principal reveal returns the value and records proof", async () => {
      /**
       * A tool shell's `assistant credentials reveal` reaches this route as
       * the direct-IPC `local` principal; its success is the ground truth
       * the chat-credential persist seams use to promote staged refs.
       */
      // GIVEN a stored credential and the staging watermark
      secureStore.set("vercel:api_token", SECRET_VALUE);
      const watermark = currentRevealSuccessWatermark();

      // WHEN revealed by the local principal
      const result = (await revealRoute!.handler({
        body: { service: "vercel", field: "api_token" },
        headers: { "x-vellum-principal-type": "local" },
      })) as { value: string };

      // THEN the value is returned and the proof is recorded
      expect(result.value).toBe(SECRET_VALUE);
      expect(revealedValueSince(watermark, "vercel", "api_token")).toBe(
        SECRET_VALUE,
      );
    });

    test("a web/gateway reveal returns the value but records no proof", async () => {
      /**
       * The Settings row and chat chips hit this same handler over HTTP or
       * the gateway proxy. Those reveals are not evidence any tool ran a
       * reveal — recording them would let a UI click promote a staged ref
       * in a concurrent turn whose command merely echoed the invocation.
       */
      secureStore.set("vercel:api_token", SECRET_VALUE);
      const watermark = currentRevealSuccessWatermark();

      for (const principal of ["user", "svc_gateway"]) {
        const result = (await revealRoute!.handler({
          body: { service: "vercel", field: "api_token" },
          headers: { "x-vellum-principal-type": principal },
        })) as { value: string };
        expect(result.value).toBe(SECRET_VALUE);
      }

      expect(
        revealedValueSince(watermark, "vercel", "api_token"),
      ).toBeUndefined();
    });

    test("a gateway-proxied local-principal reveal records no proof", async () => {
      /**
       * In local mode the gateway derives the `local` principal from the
       * verified JWT for WEB calls too, but it always stamps
       * `x-vellum-proxy-server: ipc` — only a direct (unproxied) local call
       * is a tool shell's CLI and may become proof.
       */
      secureStore.set("vercel:api_token", SECRET_VALUE);
      const watermark = currentRevealSuccessWatermark();

      const result = (await revealRoute!.handler({
        body: { service: "vercel", field: "api_token" },
        headers: {
          "x-vellum-principal-type": "local",
          "x-vellum-proxy-server": "ipc",
        },
      })) as { value: string };

      expect(result.value).toBe(SECRET_VALUE);
      expect(
        revealedValueSince(watermark, "vercel", "api_token"),
      ).toBeUndefined();
    });

    test("a reveal with no principal header records no proof (fails closed)", async () => {
      secureStore.set("vercel:api_token", SECRET_VALUE);
      const watermark = currentRevealSuccessWatermark();

      const result = (await revealRoute!.handler({
        body: { service: "vercel", field: "api_token" },
      })) as { value: string };

      expect(result.value).toBe(SECRET_VALUE);
      expect(
        revealedValueSince(watermark, "vercel", "api_token"),
      ).toBeUndefined();
    });
  });

  describe("credentials_set", () => {
    test("stores the secret and returns identifiers without leaking the value", async () => {
      /**
       * Storing a credential via the route persists the plaintext to secure
       * storage and creates metadata, but the response surfaces only the
       * credential identifiers — never the secret itself.
       */
      // GIVEN the credentials_set route is registered
      expect(setRoute).toBeDefined();

      // WHEN a credential is stored with a label, description, and allowed tools
      const result = (await setRoute!.handler({
        body: {
          service: "vercel",
          field: "api_token",
          value: SECRET_VALUE,
          label: "Vercel API Token",
          description: "Used to deploy pages",
          allowedTools: ["publish_page"],
        },
      })) as SetResponse;

      // THEN the response carries the credential identifiers only
      expect(result.service).toBe("vercel");
      expect(result.field).toBe("api_token");
      expect(result.credentialId).toBe("cred-1");

      // AND the secret is persisted to secure storage
      expect(secureStore.get("vercel:api_token")).toBe(SECRET_VALUE);

      // AND a manual-token connection sync is triggered for the service
      expect(syncedServices).toContain("vercel");

      // AND the plaintext value never appears in the response
      expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    });

    test("rejects a request missing the value", async () => {
      /**
       * The route validates required fields and rejects a store request that
       * omits the secret value before touching storage.
       */
      // GIVEN a store request with no value
      const body = { service: "vercel", field: "api_token" };

      // WHEN the handler runs
      const call = setRoute!.handler({ body });

      // THEN it rejects with a BadRequestError and stores nothing
      await expect(call).rejects.toBeInstanceOf(BadRequestError);
      expect(secureStore.size).toBe(0);
    });
  });

  describe("credentials_list", () => {
    test("returns masked metadata without exposing stored secrets", async () => {
      /**
       * Listing credentials returns metadata and a scrubbed preview for each
       * stored secret; the raw plaintext is never included in the output.
       */
      // GIVEN a stored credential
      await setRoute!.handler({
        body: {
          service: "vercel",
          field: "api_token",
          value: SECRET_VALUE,
          label: "Vercel API Token",
        },
      });

      // WHEN the credentials are listed
      const result = (await listRoute!.handler({ body: {} })) as ListResponse;

      // THEN the listing includes the credential with a masked value
      expect(result.credentials).toHaveLength(1);
      const entry = result.credentials[0];
      expect(entry.service).toBe("vercel");
      expect(entry.field).toBe("api_token");
      expect(entry.hasSecret).toBe(true);
      expect(entry.scrubbedValue).toBe("****alue");

      // AND the raw secret never appears anywhere in the response
      expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    });

    test("filters credentials by search substring", async () => {
      /**
       * The optional `search` filter restricts the listing to credentials
       * whose service, field, alias, or description match the query.
       */
      // GIVEN two stored credentials in different services
      await setRoute!.handler({
        body: { service: "vercel", field: "api_token", value: "v-secret" },
      });
      await setRoute!.handler({
        body: { service: "github", field: "token", value: "g-secret" },
      });

      // WHEN the listing is filtered by a service substring
      const result = (await listRoute!.handler({
        body: { search: "git" },
      })) as ListResponse;

      // THEN only the matching credential is returned
      expect(result.credentials).toHaveLength(1);
      expect(result.credentials[0].service).toBe("github");
    });
  });

  describe("credentials_delete", () => {
    test("removes the secret and metadata and echoes the identifiers", async () => {
      /**
       * Deleting a credential removes both the stored secret and its metadata,
       * returning the service and field that were deleted.
       */
      // GIVEN a stored credential
      await setRoute!.handler({
        body: { service: "vercel", field: "api_token", value: SECRET_VALUE },
      });
      expect(secureStore.has("vercel:api_token")).toBe(true);

      // WHEN the credential is deleted
      const result = (await deleteRoute!.handler({
        body: { service: "vercel", field: "api_token" },
      })) as DeleteResponse;

      // THEN the response echoes the identifiers
      expect(result).toEqual({ service: "vercel", field: "api_token" });

      // AND the secret and metadata are gone
      expect(secureStore.has("vercel:api_token")).toBe(false);
      expect(metadataStore.has("vercel:api_token")).toBe(false);
    });

    test("deletes the Slack user_token surgically, preserving the OAuth connection", async () => {
      /**
       * The Slack user_token grants only read access to channels the bot isn't
       * a member of; Socket Mode runs on the bot + app tokens. Deleting just the
       * user_token removes that secret without disconnecting the provider, so
       * the integration's connected state does not flap.
       */
      // GIVEN a connected Slack channel with bot, app, and user tokens
      secureStore.set("slack_channel:bot_token", "xoxb-bot");
      secureStore.set("slack_channel:app_token", "xapp-app");
      secureStore.set("slack_channel:user_token", "xoxp-user");

      // WHEN only the user_token is deleted
      const result = (await deleteRoute!.handler({
        body: { service: "slack_channel", field: "user_token" },
      })) as DeleteResponse;

      // THEN the response echoes the identifiers
      expect(result).toEqual({ service: "slack_channel", field: "user_token" });

      // AND only the user_token is removed; bot + app tokens remain
      expect(secureStore.has("slack_channel:user_token")).toBe(false);
      expect(secureStore.has("slack_channel:bot_token")).toBe(true);
      expect(secureStore.has("slack_channel:app_token")).toBe(true);

      // AND the OAuth provider is never disconnected
      expect(disconnectedProviders).not.toContain("slack_channel");
    });

    test("rejects deleting an absent Slack user_token without disconnecting the provider", async () => {
      /**
       * Deleting a Slack user_token that was never stored surfaces the same
       * not-found rejection as any other missing credential — it must not be
       * reported as an internal storage error, and it must still skip the
       * OAuth teardown so a connected channel's bot + app tokens are untouched.
       */
      // GIVEN a connected Slack channel with only bot + app tokens (no user_token)
      secureStore.set("slack_channel:bot_token", "xoxb-bot");
      secureStore.set("slack_channel:app_token", "xapp-app");

      // WHEN the absent user_token is deleted
      const call = deleteRoute!.handler({
        body: { service: "slack_channel", field: "user_token" },
      });

      // THEN it rejects with a BadRequestError (not an InternalError)
      await expect(call).rejects.toBeInstanceOf(BadRequestError);

      // AND the bot + app tokens remain and the provider is never disconnected
      expect(secureStore.has("slack_channel:bot_token")).toBe(true);
      expect(secureStore.has("slack_channel:app_token")).toBe(true);
      expect(disconnectedProviders).not.toContain("slack_channel");
    });

    test("disconnects the provider when a connection-critical Slack token is deleted", async () => {
      /**
       * Deleting a token that powers the Socket Mode connection (bot_token)
       * follows the generic path, which tears down the OAuth connection.
       */
      // GIVEN a stored Slack bot_token
      secureStore.set("slack_channel:bot_token", "xoxb-bot");

      // WHEN the bot_token is deleted
      await deleteRoute!.handler({
        body: { service: "slack_channel", field: "bot_token" },
      });

      // THEN the generic path disconnects the provider
      expect(disconnectedProviders).toContain("slack_channel");
    });

    test("rejects deleting a credential that does not exist", async () => {
      /**
       * Deleting a credential with no stored secret, metadata, or OAuth
       * connection rejects with a not-found error.
       */
      // GIVEN no stored credential for the service+field
      const body = { service: "ghost", field: "token" };

      // WHEN the handler runs
      const call = deleteRoute!.handler({ body });

      // THEN it rejects with a BadRequestError
      await expect(call).rejects.toBeInstanceOf(BadRequestError);
    });
  });
});
