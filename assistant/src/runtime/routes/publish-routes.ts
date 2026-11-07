/**
 * Route handlers for publishing/unpublishing apps.
 *
 * POST /v1/apps/:id/publish        : deploy app HTML through the configured provider
 * POST /v1/apps/:id/unpublish      : take the deployment down and mark it inactive
 * GET  /v1/apps/:id/publish-status : return current deployment state
 *
 * Which provider runs is `apps.publish.provider`; every response names it so
 * clients can label the affordance without knowing the provider set.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { v4 as uuid } from "uuid";
import { z } from "zod";

import {
  getApp,
  getAppDirPath,
  resolveEffectiveAppHtml,
} from "../../apps/app-store.js";
import {
  getActivePublishedPageByAppId,
  insertPublishedPage,
  updatePublishedPage,
} from "../../apps/published-pages-store.js";
import { compileApp } from "../../bundler/app-compiler.js";
import {
  getPublishProvider,
  withPublishCredential,
} from "../../services/publish/registry.js";
import { appSlug } from "../../services/publish/types.js";
import { getCredentialMetadata } from "../../tools/credentials/metadata-store.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("publish-routes");

// Optional on the wire, always sent by these handlers: a web bundle newer than
// the assistant it is talking to must be able to tell an assistant that names
// no provider (Vercel only) from one that names a provider.
const providerResponseFields = {
  provider: z
    .string()
    .optional()
    .describe("Id of the configured publish provider"),
  providerName: z
    .string()
    .optional()
    .describe("Display name of the configured publish provider"),
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePublish({ pathParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const app = getApp(appId);
  if (!app) {
    throw new NotFoundError(`App not found: ${appId}`);
  }

  const provider = getPublishProvider();
  const providerFields = {
    provider: provider.id,
    providerName: provider.displayName,
  };

  // Answer a missing required credential before compiling: the compile is the
  // expensive half and a deploy that cannot authenticate will not run anyway.
  const { service, field, required, missingMessage } = provider.credential;
  if (required && !getCredentialMetadata(service, field)) {
    return {
      ...providerFields,
      success: false,
      errorCode: "credentials_missing",
      error: missingMessage,
    };
  }

  // Compile if needed (same pattern as handleOpenApp)
  const appDir = getAppDirPath(appId);
  const distIndex = join(appDir, "dist", "index.html");
  if (!existsSync(distIndex)) {
    const result = await compileApp(appDir);
    if (!result.ok) {
      log.warn(
        { appId, errors: result.errors },
        "Auto-compile failed before publish",
      );
      return {
        ...providerFields,
        success: false,
        errorCode: "compile_failed",
        error: `App failed to compile: ${result.errors?.join("; ") ?? "unknown error"}`,
      };
    }
  }

  const html = resolveEffectiveAppHtml(app);
  if (!html) {
    return {
      ...providerFields,
      success: false,
      errorCode: "no_html",
      error: "App has no HTML content to publish",
    };
  }

  const existing = getActivePublishedPageByAppId(appId);
  const slug = appSlug(app.name);
  const meta = {
    appId,
    name: app.name,
    slug,
    previousDeploymentId: existing?.deploymentId,
  };

  const outcome = await withPublishCredential(
    provider,
    "publish_page",
    async (token) => {
      const result = await provider.deploy(html, meta, token);

      const htmlHash = createHash("sha256").update(html).digest("hex");
      if (existing) {
        updatePublishedPage(existing.id, {
          deploymentId: result.deploymentId,
          publicUrl: result.url,
          htmlHash,
          publishedAt: Date.now(),
        });
      } else {
        insertPublishedPage({
          id: uuid(),
          deploymentId: result.deploymentId,
          publicUrl: result.url,
          pageTitle: app.name,
          htmlHash,
          publishedAt: Date.now(),
          status: "active",
          appId,
          projectSlug: slug,
        });
      }

      return result;
    },
  );

  if (!outcome.success) {
    return {
      ...providerFields,
      success: false,
      errorCode: outcome.credentialMissing
        ? "credentials_missing"
        : "deploy_failed",
      error: outcome.credentialMissing ? missingMessage : outcome.reason,
    };
  }

  return {
    ...providerFields,
    success: true,
    publicUrl: outcome.result.url,
    deploymentId: outcome.result.deploymentId,
  };
}

async function handleUnpublish({ pathParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const provider = getPublishProvider();
  const providerFields = {
    provider: provider.id,
    providerName: provider.displayName,
  };

  const published = getActivePublishedPageByAppId(appId);
  if (!published) {
    return {
      ...providerFields,
      success: false,
      error: "No active deployment found",
    };
  }

  const { unpublish } = provider;
  if (unpublish) {
    const app = getApp(appId);
    const outcome = await withPublishCredential(
      provider,
      "unpublish_page",
      (token) =>
        unpublish(
          {
            appId,
            name: app?.name ?? published.pageTitle ?? appId,
            slug: published.projectSlug ?? appSlug(app?.name ?? appId),
            previousDeploymentId: published.deploymentId,
          },
          token,
        ),
    );

    // Leave the record active when the provider could not take the deployment
    // down: a record marked inactive while the page is still reachable is the
    // worse of the two divergences.
    if (!outcome.success) {
      log.warn(
        { appId, provider: provider.id, reason: outcome.reason },
        "Provider unpublish failed",
      );
      return { ...providerFields, success: false, error: outcome.reason };
    }
  }

  updatePublishedPage(published.id, { status: "inactive" });
  return { ...providerFields, success: true };
}

function handlePublishStatus({ pathParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const provider = getPublishProvider();
  const providerFields = {
    provider: provider.id,
    providerName: provider.displayName,
  };

  const published = getActivePublishedPageByAppId(appId);
  if (!published) {
    return { ...providerFields, published: false };
  }

  return {
    ...providerFields,
    published: true,
    publicUrl: published.publicUrl,
    deploymentId: published.deploymentId,
    publishedAt: published.publishedAt,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "apps_publish",
    endpoint: "apps/:id/publish",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handlePublish,
    summary: "Publish app",
    description:
      "Deploy the app's HTML through the configured publish provider and store the deployment record.",
    tags: ["apps"],
    responseBody: z.object({
      ...providerResponseFields,
      success: z.boolean(),
      publicUrl: z.string().optional(),
      deploymentId: z.string().optional(),
      errorCode: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  {
    operationId: "apps_unpublish",
    endpoint: "apps/:id/unpublish",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleUnpublish,
    summary: "Unpublish app",
    description:
      "Take the active deployment down at the publish provider and mark it inactive.",
    tags: ["apps"],
    responseBody: z.object({
      ...providerResponseFields,
      success: z.boolean(),
      error: z.string().optional(),
    }),
  },
  {
    operationId: "apps_publish_status",
    endpoint: "apps/:id/publish-status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handlePublishStatus,
    summary: "Get app publish status",
    description:
      "Return the current deployment state for an app, plus the configured publish provider.",
    tags: ["apps"],
    responseBody: z.object({
      ...providerResponseFields,
      published: z.boolean(),
      publicUrl: z.string().optional(),
      deploymentId: z.string().optional(),
      publishedAt: z.number().optional(),
    }),
  },
];
