import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SlackChannelConfigResult } from "../daemon/handlers/config-slack-channel.js";
import type { SecretPromptResult } from "../permissions/secret-prompter.js";

// ---------------------------------------------------------------------------
// Mutable mock state (closed over by the mock factories below)
// ---------------------------------------------------------------------------

let capturedSecretParams: Record<string, unknown> | undefined;
let capturedMetadata: Record<string, unknown> | undefined;
let secretResult: SecretPromptResult = {
  value: "secret-value",
  delivery: "store",
};
let allowOneTimeSend = true;
let existingMetadata: Record<string, unknown> | undefined;
let slackConfigResult: SlackChannelConfigResult;
let slackConfigArgs: Array<(string | undefined)[]>;
let secureKeyWrites: Array<{ key: string; value: string }>;
let transientInjections: Array<{
  service: string;
  field: string;
  value: string;
}>;
let syncedServices: string[];

// ---------------------------------------------------------------------------
// Mocks for the route's collaborators
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../daemon/handlers/shared.js", () => ({
  requestSecretStandalone: mock(
    async (params: Record<string, unknown>): Promise<SecretPromptResult> => {
      capturedSecretParams = params;
      return secretResult;
    },
  ),
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: () => {},
  getCredentialMetadata: mock(() => existingMetadata),
  upsertCredentialMetadata: mock(
    (service: string, field: string, meta: Record<string, unknown>) => {
      capturedMetadata = { service, field, ...meta };
    },
  ),
}));

mock.module("../security/secure-keys.js", () => ({
  setSecureKeyAsync: mock(async (key: string, value: string) => {
    secureKeyWrites.push({ key, value });
    return true;
  }),
}));

mock.module("../security/credential-key.js", () => ({
  credentialKey: (service: string, field: string) => `${service}:${field}`,
}));

mock.module("../oauth/manual-token-connection.js", () => ({
  syncManualTokenConnection: mock(async (service: string) => {
    syncedServices.push(service);
  }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ secretDetection: { allowOneTimeSend } }),
}));

mock.module("../daemon/handlers/config-slack-channel.js", () => ({
  setSlackChannelConfig: mock(
    async (
      botToken?: string,
      appToken?: string,
      userToken?: string,
    ): Promise<SlackChannelConfigResult> => {
      slackConfigArgs.push([botToken, appToken, userToken]);
      return slackConfigResult;
    },
  ),
}));

mock.module("../tools/credentials/broker.js", () => ({
  credentialBroker: {
    injectTransient: mock((service: string, field: string, value: string) => {
      transientInjections.push({ service, field, value });
    }),
  },
}));

import { ROUTES } from "../runtime/routes/credential-prompt-routes.js";

const promptRoute = ROUTES.find((r) => r.operationId === "credentials_prompt");

function slackResult(
  overrides: Partial<SlackChannelConfigResult>,
): SlackChannelConfigResult {
  return {
    success: true,
    hasBotToken: false,
    hasAppToken: false,
    hasUserToken: false,
    connected: false,
    ...overrides,
  };
}

type PromptResponse = {
  ok: boolean;
  error?: string;
  service?: string;
  field?: string;
  message?: string;
};

describe("credentials/prompt route", () => {
  beforeEach(() => {
    capturedSecretParams = undefined;
    capturedMetadata = undefined;
    secretResult = { value: "secret-value", delivery: "store" };
    allowOneTimeSend = true;
    existingMetadata = undefined;
    slackConfigResult = slackResult({});
    slackConfigArgs = [];
    secureKeyWrites = [];
    transientInjections = [];
    syncedServices = [];
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
    })) as PromptResponse;

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
    })) as PromptResponse;

    // THEN no purpose is forwarded to the prompt
    expect(result.ok).toBe(true);
    expect(capturedSecretParams?.purpose).toBeUndefined();

    // AND no usageDescription is written to metadata
    expect(capturedMetadata?.usageDescription).toBeUndefined();
  });

  test("stores a non-slack credential to secure storage without a message", async () => {
    /**
     * The default delivery persists the value to secure storage and runs the
     * manual-token connection sync, returning no message so the CLI prints its
     * generic "Stored credential" line.
     */
    // GIVEN a standard store-delivery prompt for a non-slack credential
    // WHEN the route handles it
    const result = (await promptRoute!.handler({
      body: { service: "stripe", field: "api_key", label: "Stripe API Key" },
    })) as PromptResponse;

    // THEN the value is written to secure storage
    expect(result.ok).toBe(true);
    expect(secureKeyWrites).toEqual([
      { key: "stripe:api_key", value: "secret-value" },
    ]);

    // AND the manual token connection is synced for the service
    expect(syncedServices).toEqual(["stripe"]);

    // AND no message is returned (the CLI falls back to its default line)
    expect(result.message).toBeUndefined();
  });

  test("connects the channel when a slack_channel token is provided", async () => {
    /**
     * Slack channel tokens must route through the Slack channel config so the
     * channel actually connects, and the route surfaces the connection status
     * to the CLI via `message`.
     */
    // GIVEN the Slack channel config reports a successful connection
    slackConfigResult = slackResult({
      connected: true,
      teamName: "Acme",
      botUsername: "acmebot",
    });

    // WHEN a slack_channel bot_token is submitted
    const result = (await promptRoute!.handler({
      body: {
        service: "slack_channel",
        field: "bot_token",
        label: "Slack Bot Token",
      },
    })) as PromptResponse;

    // THEN the token is routed through the Slack channel config, not secure storage
    expect(slackConfigArgs).toEqual([["secret-value", undefined, undefined]]);
    expect(secureKeyWrites).toEqual([]);

    // AND the connection status is surfaced as the response message
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Slack channel connected to Acme (@acmebot).");
  });

  test("surfaces the warning when a slack_channel connection is incomplete", async () => {
    /**
     * When only one of the required Slack tokens is present the config returns a
     * warning instead of a connection; the route surfaces it so the user knows
     * to provide the remaining token.
     */
    // GIVEN the Slack channel config reports an incomplete connection
    slackConfigResult = slackResult({
      warning: "Slack channel connection incomplete; provide the app token.",
    });

    // WHEN a slack_channel app_token is submitted
    const result = (await promptRoute!.handler({
      body: {
        service: "slack_channel",
        field: "app_token",
        label: "Slack App Token",
      },
    })) as PromptResponse;

    // THEN the warning is surfaced as the response message
    expect(result.ok).toBe(true);
    expect(result.message).toBe(
      "Slack channel connection incomplete; provide the app token.",
    );
  });

  test("fails when the slack_channel config rejects the token", async () => {
    /**
     * A failed Slack configuration (e.g. invalid_auth) must surface as an error
     * rather than silently storing an unusable token.
     */
    // GIVEN the Slack channel config rejects the token
    slackConfigResult = slackResult({ success: false, error: "invalid_auth" });

    // WHEN a slack_channel bot_token is submitted
    const result = (await promptRoute!.handler({
      body: {
        service: "slack_channel",
        field: "bot_token",
        label: "Slack Bot Token",
      },
    })) as PromptResponse;

    // THEN the route returns the configuration error
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_auth");
  });

  test("injects a one-time credential without persisting it", async () => {
    /**
     * One-time-send delivery hands the value to the broker for the next
     * operation and must never write it to secure storage.
     */
    // GIVEN one-time send is enabled and the user chose transient delivery
    allowOneTimeSend = true;
    secretResult = { value: "secret-value", delivery: "transient_send" };

    // WHEN a non-slack credential is submitted for one-time use
    const result = (await promptRoute!.handler({
      body: { service: "stripe", field: "api_key", label: "Stripe API Key" },
    })) as PromptResponse;

    // THEN the value is injected into the broker, not secure storage
    expect(transientInjections).toEqual([
      { service: "stripe", field: "api_key", value: "secret-value" },
    ]);
    expect(secureKeyWrites).toEqual([]);

    // AND the response message notes the value was not saved
    expect(result.ok).toBe(true);
    expect(result.message).toContain("One-time credential provided");
  });

  test("rejects one-time send when it is disabled in config", async () => {
    /**
     * Transient delivery requires the secretDetection.allowOneTimeSend config
     * flag; otherwise the value is rejected rather than injected.
     */
    // GIVEN one-time send is disabled and the user chose transient delivery
    allowOneTimeSend = false;
    secretResult = { value: "secret-value", delivery: "transient_send" };

    // WHEN a credential is submitted for one-time use
    const result = (await promptRoute!.handler({
      body: { service: "stripe", field: "api_key", label: "Stripe API Key" },
    })) as PromptResponse;

    // THEN the request is rejected and nothing is injected
    expect(result.ok).toBe(false);
    expect(result.error).toContain("one-time send is not enabled");
    expect(transientInjections).toEqual([]);
  });

  test("rejects one-time send for slack_channel credentials", async () => {
    /**
     * Slack channel tokens must be saved so the channel can connect; a one-time
     * send for them is rejected.
     */
    // GIVEN the user chose transient delivery for a slack_channel token
    secretResult = { value: "secret-value", delivery: "transient_send" };

    // WHEN a slack_channel bot_token is submitted for one-time use
    const result = (await promptRoute!.handler({
      body: {
        service: "slack_channel",
        field: "bot_token",
        label: "Slack Bot Token",
      },
    })) as PromptResponse;

    // THEN the request is rejected without injecting or connecting
    expect(result.ok).toBe(false);
    expect(result.error).toContain("must be saved to secure storage");
    expect(transientInjections).toEqual([]);
    expect(slackConfigArgs).toEqual([]);
  });

  test("omitting allowed-tools/-domains forwards undefined so an existing policy is preserved", async () => {
    /**
     * Rotating an existing credential without policy flags must not wipe its
     * allowed tools/domains. The route forwards `undefined` (not `[]`) for
     * omitted flags so the metadata store's partial-update path leaves the
     * existing policy untouched.
     */
    // GIVEN a credential already exists with an allowed-tools policy
    existingMetadata = {
      service: "github",
      field: "pat",
      allowedTools: ["bash"],
      allowedDomains: ["github.com"],
    };

    // WHEN it is re-prompted without allowed-tools or allowed-domains
    const result = (await promptRoute!.handler({
      body: { service: "github", field: "pat", label: "GitHub PAT" },
    })) as PromptResponse;

    // THEN the metadata upsert receives undefined for both lists
    expect(result.ok).toBe(true);
    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata!.allowedTools).toBeUndefined();
    expect(capturedMetadata!.allowedDomains).toBeUndefined();
  });

  test("forwards provided allowed-tools/-domains to credential metadata", async () => {
    /**
     * When the caller does supply policy flags they must reach the metadata
     * store verbatim, including an explicit empty array used to set a deny-all
     * policy.
     */
    // GIVEN a prompt request that supplies an allowed-tools list and a
    // deny-all (empty) allowed-domains list
    // WHEN the route handles it
    const result = (await promptRoute!.handler({
      body: {
        service: "stripe",
        field: "api_key",
        label: "Stripe API Key",
        allowedTools: ["make_authenticated_request"],
        allowedDomains: [],
      },
    })) as PromptResponse;

    // THEN the metadata upsert receives the supplied lists verbatim
    expect(result.ok).toBe(true);
    expect(capturedMetadata!.allowedTools).toEqual([
      "make_authenticated_request",
    ]);
    expect(capturedMetadata!.allowedDomains).toEqual([]);
  });
});
