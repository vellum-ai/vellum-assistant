import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SecretPromptResult } from "../permissions/secret-prompter.js";

// ---------------------------------------------------------------------------
// Mocks for the route's collaborators
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let capturedSecretParams: Record<string, unknown> | undefined;

mock.module("../daemon/handlers/shared.js", () => ({
  requestSecretStandalone: mock(
    async (params: Record<string, unknown>): Promise<SecretPromptResult> => {
      capturedSecretParams = params;
      return { value: "secret-value", delivery: "store" };
    },
  ),
}));

let capturedMetadata: Record<string, unknown> | undefined;

mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: () => {},
  upsertCredentialMetadata: mock(
    (service: string, field: string, meta: Record<string, unknown>) => {
      capturedMetadata = { service, field, ...meta };
    },
  ),
}));

mock.module("../security/secure-keys.js", () => ({
  setSecureKeyAsync: mock(async () => true),
}));

mock.module("../oauth/manual-token-connection.js", () => ({
  syncManualTokenConnection: mock(async () => {}),
}));

import { ROUTES } from "../runtime/routes/credential-prompt-routes.js";

const promptRoute = ROUTES.find((r) => r.operationId === "credentials_prompt");

describe("credentials/prompt route threads usageDescription", () => {
  beforeEach(() => {
    capturedSecretParams = undefined;
    capturedMetadata = undefined;
  });

  test("forwards usageDescription as the prompt purpose and to metadata", async () => {
    /**
     * The CLI `credentials prompt` command exposes `--usage-description` to
     * match the credential_store tool's prompt action. The route must thread
     * it to the secure prompt (as `purpose`, shown to the user) and persist it
     * to credential metadata (as `usageDescription`).
     */
    // GIVEN the credentials/prompt route is registered
    expect(promptRoute).toBeDefined();

    // WHEN a prompt request carries a usageDescription
    const result = (await promptRoute!.handler({
      body: {
        service: "sentry",
        field: "auth_token",
        label: "Sentry Auth Token",
        usageDescription: "Needed to read issues",
      },
    })) as { ok: boolean; service?: string; field?: string };

    // THEN the prompt is issued with the usageDescription as its purpose
    expect(result.ok).toBe(true);
    expect(capturedSecretParams?.purpose).toBe("Needed to read issues");

    // AND the credential metadata records the usageDescription
    expect(capturedMetadata?.usageDescription).toBe("Needed to read issues");
  });

  test("omits purpose when usageDescription is not provided", async () => {
    /**
     * usageDescription is optional, so a prompt without it must not invent a
     * purpose or a metadata usageDescription.
     */
    // GIVEN a prompt request with no usageDescription
    // WHEN the route handles it
    const result = (await promptRoute!.handler({
      body: {
        service: "github",
        field: "pat",
        label: "GitHub PAT",
      },
    })) as { ok: boolean };

    // THEN no purpose is forwarded to the prompt
    expect(result.ok).toBe(true);
    expect(capturedSecretParams?.purpose).toBeUndefined();

    // AND no usageDescription is written to metadata
    expect(capturedMetadata?.usageDescription).toBeUndefined();
  });
});
