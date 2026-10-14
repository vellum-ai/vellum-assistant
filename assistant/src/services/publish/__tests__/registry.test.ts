/**
 * Publish provider selection and the credential wrapper around a deploy.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { AppsConfigSchema } from "../../../config/schemas/apps.js";
import type { PublishProvider } from "../types.js";

let appsConfig: unknown = AppsConfigSchema.parse({});

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({ apps: AppsConfigSchema.parse(appsConfig) }),
}));

let storedMetadata: Record<string, { allowedTools: string[] }> = {};

mock.module("../../../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: (service: string, field: string) =>
    storedMetadata[`${service}/${field}`],
}));

const serverUse = mock(
  async ({
    service,
    field,
    execute,
  }: {
    service: string;
    field: string;
    execute: (token: string) => Promise<unknown>;
  }) => {
    if (!storedMetadata[`${service}/${field}`]) {
      return {
        success: false,
        reason: `No credential found for ${service}/${field}`,
      };
    }
    try {
      return { success: true, result: await execute("stored-secret") };
    } catch {
      return { success: false, reason: "Credential use failed" };
    }
  },
);

mock.module("../../../tools/credentials/broker.js", () => ({
  credentialBroker: { serverUse },
}));

const { getPublishProvider, withPublishCredential } =
  await import("../registry.js");

function fakeProvider(
  overrides: Partial<PublishProvider> = {},
): PublishProvider {
  return {
    id: "webhook",
    displayName: "Webhook",
    credential: {
      service: "publish_webhook",
      field: "token",
      required: false,
      missingMessage: "missing",
    },
    deploy: async () => ({ url: "https://x.test", deploymentId: "d" }),
    ...overrides,
  };
}

beforeEach(() => {
  appsConfig = AppsConfigSchema.parse({});
  storedMetadata = {};
  serverUse.mockClear();
});

describe("getPublishProvider", () => {
  test("defaults to Vercel", () => {
    const provider = getPublishProvider();
    expect(provider.id).toBe("vercel");
    expect(provider.displayName).toBe("Vercel");
    expect(provider.credential).toMatchObject({
      service: "vercel",
      field: "api_token",
      required: true,
    });
  });

  test("selects the webhook provider when configured", () => {
    appsConfig = { publish: { provider: "webhook" } };
    const provider = getPublishProvider();
    expect(provider.id).toBe("webhook");
    expect(provider.credential.required).toBe(false);
  });

  test("falls back to the default for an unknown provider id", () => {
    // The schema's `.catch` already repairs this, so the fallback is reached
    // through config rather than by indexing a missing provider.
    appsConfig = { publish: { provider: "coolify" } };
    expect(getPublishProvider().id).toBe("vercel");
  });
});

describe("withPublishCredential", () => {
  test("runs unauthenticated when an optional credential is not stored", async () => {
    const seen: (string | null)[] = [];
    const outcome = await withPublishCredential(
      fakeProvider(),
      "publish_page",
      async (token) => {
        seen.push(token);
        return "deployed";
      },
    );

    expect(outcome).toEqual({ success: true, result: "deployed" });
    expect(seen).toEqual([null]);
    expect(serverUse).not.toHaveBeenCalled();
  });

  test("goes through the broker when an optional credential is stored", async () => {
    storedMetadata["publish_webhook/token"] = {
      allowedTools: ["publish_page"],
    };
    const seen: (string | null)[] = [];

    const outcome = await withPublishCredential(
      fakeProvider(),
      "publish_page",
      async (token) => {
        seen.push(token);
        return "deployed";
      },
    );

    expect(outcome).toEqual({ success: true, result: "deployed" });
    expect(seen).toEqual(["stored-secret"]);
    expect(serverUse).toHaveBeenCalledTimes(1);
  });

  test("reports a missing required credential as credentialMissing", async () => {
    const provider = fakeProvider({
      credential: {
        service: "vercel",
        field: "api_token",
        required: true,
        missingMessage: "Vercel API token not configured",
      },
    });

    const outcome = await withPublishCredential(
      provider,
      "publish_page",
      async () => "deployed",
    );

    expect(outcome).toEqual({
      success: false,
      reason: "No credential found for vercel/api_token",
      credentialMissing: true,
    });
  });

  test("surfaces the thrown message when running unauthenticated fails", async () => {
    const outcome = await withPublishCredential(
      fakeProvider(),
      "publish_page",
      async () => {
        throw new Error("apps.publish.webhook.url is not set");
      },
    );

    expect(outcome).toEqual({
      success: false,
      reason: "apps.publish.webhook.url is not set",
      credentialMissing: false,
    });
  });

  test("does not read a deploy failure as a missing credential", async () => {
    storedMetadata["publish_webhook/token"] = {
      allowedTools: ["publish_page"],
    };

    const outcome = await withPublishCredential(
      fakeProvider(),
      "publish_page",
      async () => {
        throw new Error("Publish webhook failed (500): boom");
      },
    );

    expect(outcome).toEqual({
      success: false,
      reason: "Credential use failed",
      credentialMissing: false,
    });
  });
});
