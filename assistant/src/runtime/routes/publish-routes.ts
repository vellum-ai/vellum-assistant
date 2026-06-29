/**
 * Route handlers for publishing/unpublishing apps to Vercel.
 *
 * POST /v1/apps/:id/publish       — deploy app HTML to Vercel
 * POST /v1/apps/:id/unpublish     — mark deployment as inactive
 * GET  /v1/apps/:id/publish-status — return current deployment state
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { v4 as uuid } from "uuid";
import { z } from "zod";

import {
  getApp,
  getAppDirPath,
  isMultifileApp,
  resolveEffectiveAppHtml,
} from "../../apps/app-store.js";
import {
  getActivePublishedPageByAppId,
  insertPublishedPage,
  updatePublishedPage,
} from "../../apps/published-pages-store.js";
import { compileApp } from "../../bundler/app-compiler.js";
import { deployHtmlToVercel } from "../../services/vercel-deploy.js";
import { credentialBroker } from "../../tools/credentials/broker.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("publish-routes");

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePublish({ pathParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const app = getApp(appId);
  if (!app) {
    throw new NotFoundError(`App not found: ${appId}`);
  }

  // Compile multi-file apps if needed (same pattern as handleOpenApp)
  if (isMultifileApp(app)) {
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
          success: false,
          errorCode: "compile_failed",
          error: `App failed to compile: ${result.errors?.join("; ") ?? "unknown error"}`,
        };
      }
    }
  }

  const html = resolveEffectiveAppHtml(app);
  if (!html) {
    return {
      success: false,
      errorCode: "no_html",
      error: "App has no HTML content to publish",
    };
  }

  // Get Vercel token via credential broker
  const useResult = await credentialBroker.serverUse({
    service: "vercel",
    field: "api_token",
    toolName: "publish_page",
    execute: async (token) => {
      const result = await deployHtmlToVercel({
        html,
        name: app.name,
        token,
      });

      const htmlHash = createHash("sha256").update(html).digest("hex");
      const slug = app.name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      // Create or update the published page record
      const existing = getActivePublishedPageByAppId(appId);
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
  });

  if (!useResult.success || !useResult.result) {
    const isMissing =
      useResult.reason?.includes("No credential found") ||
      useResult.reason?.includes("no stored value");
    return {
      success: false,
      errorCode: isMissing ? "credentials_missing" : "deploy_failed",
      error: isMissing
        ? "Vercel API token not configured"
        : (useResult.reason ?? "Deploy failed"),
    };
  }

  return {
    success: true,
    publicUrl: useResult.result.url,
    deploymentId: useResult.result.deploymentId,
  };
}

function handleUnpublish({ pathParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const published = getActivePublishedPageByAppId(appId);
  if (!published) {
    return { success: false, error: "No active deployment found" };
  }

  updatePublishedPage(published.id, { status: "inactive" });
  return { success: true };
}

function handlePublishStatus({ pathParams }: RouteHandlerArgs) {
  const appId = pathParams?.id as string;
  const published = getActivePublishedPageByAppId(appId);
  if (!published) {
    return { published: false };
  }

  return {
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
    summary: "Publish app to Vercel",
    description:
      "Deploy the app's HTML to Vercel and store the deployment record.",
    tags: ["apps"],
    responseBody: z.object({
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
    summary: "Unpublish app from Vercel",
    description: "Mark the active Vercel deployment as inactive.",
    tags: ["apps"],
    responseBody: z.object({
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
    description: "Return the current Vercel deployment state for an app.",
    tags: ["apps"],
    responseBody: z.object({
      published: z.boolean(),
      publicUrl: z.string().optional(),
      deploymentId: z.string().optional(),
      publishedAt: z.number().optional(),
    }),
  },
];
