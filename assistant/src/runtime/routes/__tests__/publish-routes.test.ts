/**
 * Publish routes: which provider runs, how it is named back to the client, and
 * what happens when the provider cannot authenticate or cannot take a
 * deployment down.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { AppsConfigSchema } from "../../../config/schemas/apps.js";
import type {
  AppPublishMeta,
  PublishProvider,
} from "../../../services/publish/types.js";

let appsConfig: unknown = AppsConfigSchema.parse({});

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({ apps: AppsConfigSchema.parse(appsConfig) }),
}));

let storedMetadata: Record<string, { allowedTools: string[] }> = {};

mock.module("../../../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: (service: string, field: string) =>
    storedMetadata[`${service}/${field}`],
}));

mock.module("../../../tools/credentials/broker.js", () => ({
  credentialBroker: {
    serverUse: async ({
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
  },
}));

mock.module("../../../apps/app-store.js", () => ({
  getApp: (id: string) =>
    id === "app-1" ? { id: "app-1", name: "Budget Tracker" } : null,
  getAppDirPath: () => "/tmp/__vellum_publish_routes_test__/app-1",
  resolveEffectiveAppHtml: () => "<html>app</html>",
}));

let activePage: {
  id: string;
  deploymentId: string;
  publicUrl: string;
  pageTitle: string | null;
  projectSlug: string | null;
  publishedAt: number;
} | null = null;
const updatePublishedPage = mock(
  (_id: string, _updates: Record<string, unknown>) => {},
);
const insertPublishedPage = mock((_record: Record<string, unknown>) => {});

mock.module("../../../apps/published-pages-store.js", () => ({
  getActivePublishedPageByAppId: () => activePage,
  insertPublishedPage,
  updatePublishedPage,
}));

mock.module("../../../bundler/app-compiler.js", () => ({
  compileApp: async () => ({ ok: true }),
}));

const deploy = mock(
  async (_html: string, _meta: AppPublishMeta, _token: string | null) => ({
    url: "https://budget-tracker.example.com",
    deploymentId: "dep-1",
  }),
);
const unpublish = mock(
  async (_meta: AppPublishMeta, _token: string | null) => {},
);

// The registry selects between these two by `apps.publish.provider`, so the
// route's provider plumbing runs through real selection. The registry captures
// both objects at import, so a test varies one by mutating it in place.
const vercelProvider: PublishProvider = {
  id: "vercel",
  displayName: "Vercel",
  credential: {
    service: "vercel",
    field: "api_token",
    required: true,
    missingMessage: "Vercel API token not configured",
  },
  deploy,
};

const webhookProvider: PublishProvider = {
  id: "webhook",
  displayName: "Webhook",
  credential: {
    service: "publish_webhook",
    field: "token",
    required: false,
    missingMessage: "no token",
  },
  deploy,
};

mock.module("../../../services/publish/vercel-provider.js", () => ({
  vercelPublishProvider: vercelProvider,
}));

mock.module("../../../services/publish/webhook-provider.js", () => ({
  webhookPublishProvider: webhookProvider,
}));

const { ROUTES } = await import("../publish-routes.js");

function handlerFor(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`No route ${operationId}`);
  }
  return route.handler;
}

const publish = handlerFor("apps_publish");
const unpublishRoute = handlerFor("apps_unpublish");
const publishStatus = handlerFor("apps_publish_status");

const ARGS = { pathParams: { id: "app-1" } };

beforeEach(() => {
  appsConfig = AppsConfigSchema.parse({});
  storedMetadata = { "vercel/api_token": { allowedTools: ["publish_page"] } };
  activePage = null;
  delete vercelProvider.unpublish;
  deploy.mockClear();
  unpublish.mockClear();
  updatePublishedPage.mockClear();
  insertPublishedPage.mockClear();
});

describe("POST apps/:id/publish", () => {
  test("names the provider alongside the deployed url", async () => {
    expect(await publish(ARGS)).toEqual({
      provider: "vercel",
      providerName: "Vercel",
      success: true,
      publicUrl: "https://budget-tracker.example.com",
      deploymentId: "dep-1",
    });
    expect(insertPublishedPage).toHaveBeenCalledTimes(1);
  });

  test("short-circuits a missing required credential before deploying", async () => {
    storedMetadata = {};

    expect(await publish(ARGS)).toEqual({
      provider: "vercel",
      providerName: "Vercel",
      success: false,
      errorCode: "credentials_missing",
      error: "Vercel API token not configured",
    });
    expect(deploy).not.toHaveBeenCalled();
  });

  test("reports a provider failure as deploy_failed", async () => {
    deploy.mockImplementationOnce(async () => {
      throw new Error("Vercel deploy failed (402): over quota");
    });

    expect(await publish(ARGS)).toMatchObject({
      provider: "vercel",
      success: false,
      errorCode: "deploy_failed",
    });
  });

  test("carries the webhook provider's name through", async () => {
    appsConfig = { publish: { provider: "webhook" } };
    storedMetadata = {};

    expect(await publish(ARGS)).toMatchObject({
      provider: "webhook",
      providerName: "Webhook",
      success: true,
    });
    // An optional, unstored credential deploys unauthenticated.
    expect(deploy.mock.calls[0][2]).toBeNull();
  });
});

describe("POST apps/:id/unpublish", () => {
  beforeEach(() => {
    activePage = {
      id: "pp-1",
      deploymentId: "dep-0",
      publicUrl: "https://budget-tracker.example.com",
      pageTitle: "Budget Tracker",
      projectSlug: "budget-tracker",
      publishedAt: 1,
    };
  });

  test("marks the record inactive for a provider with no takedown", async () => {
    expect(await unpublishRoute(ARGS)).toEqual({
      provider: "vercel",
      providerName: "Vercel",
      success: true,
    });
    expect(updatePublishedPage).toHaveBeenCalledWith("pp-1", {
      status: "inactive",
    });
  });

  test("asks a provider that can take the deployment down", async () => {
    vercelProvider.unpublish = unpublish;

    expect(await unpublishRoute(ARGS)).toMatchObject({ success: true });
    expect(unpublish.mock.calls[0][0]).toEqual({
      appId: "app-1",
      name: "Budget Tracker",
      slug: "budget-tracker",
      previousDeploymentId: "dep-0",
    });
  });

  test("keeps the record active when the takedown fails", async () => {
    vercelProvider.unpublish = async () => {
      throw new Error("gone sideways");
    };

    expect(await unpublishRoute(ARGS)).toMatchObject({ success: false });
    expect(updatePublishedPage).not.toHaveBeenCalled();
  });
});

describe("GET apps/:id/publish-status", () => {
  test("names the provider even when nothing is published", async () => {
    expect(await publishStatus(ARGS)).toEqual({
      provider: "vercel",
      providerName: "Vercel",
      published: false,
    });
  });

  test("names the provider alongside the live deployment", async () => {
    activePage = {
      id: "pp-1",
      deploymentId: "dep-0",
      publicUrl: "https://budget-tracker.example.com",
      pageTitle: "Budget Tracker",
      projectSlug: "budget-tracker",
      publishedAt: 42,
    };

    expect(await publishStatus(ARGS)).toEqual({
      provider: "vercel",
      providerName: "Vercel",
      published: true,
      publicUrl: "https://budget-tracker.example.com",
      deploymentId: "dep-0",
      publishedAt: 42,
    });
  });
});
