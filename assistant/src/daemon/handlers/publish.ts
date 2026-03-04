import { createHash } from "node:crypto";
import * as net from "node:net";

import { v4 as uuid } from "uuid";

import {
  createPublishedPage,
  getPublishedPageByDeploymentId,
  getPublishedPageByHash,
  markDeleted,
  updatePublishedPage,
} from "../../memory/published-pages-store.js";
import {
  deleteVercelDeployment,
  deployHtmlToVercel,
} from "../../services/vercel-deploy.js";
import { credentialBroker } from "../../tools/credentials/broker.js";
import type {
  PublishPageRequest,
  UnpublishPageRequest,
} from "../ipc-protocol.js";
import { defineHandlers, type HandlerContext, log } from "./shared.js";

export async function handlePublishPage(
  msg: PublishPageRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    // Hash the HTML for dedup — can be done before credential check
    const htmlHash = createHash("sha256").update(msg.html).digest("hex");

    // Check if already published (no credential needed)
    const existing = getPublishedPageByHash(htmlHash);
    if (existing) {
      // Link the existing deployment to this app if not already linked
      if (msg.appId && !existing.appId) {
        updatePublishedPage(existing.id, { appId: msg.appId });
      }
      ctx.send(socket, {
        type: "publish_page_response",
        success: true,
        publicUrl: existing.publicUrl,
        deploymentId: existing.deploymentId,
      });
      return;
    }

    const publishExecute = async (token: string) => {
      const name = msg.title
        ? msg.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 50)
        : `vellum-page-${Date.now()}`;

      const result = await deployHtmlToVercel({ html: msg.html, name, token });

      const id = uuid();
      createPublishedPage({
        id,
        deploymentId: result.deploymentId,
        publicUrl: result.url,
        pageTitle: msg.title,
        htmlHash,
        appId: msg.appId,
        projectSlug: name,
      });

      return { url: result.url, deploymentId: result.deploymentId };
    };

    const useResult = await credentialBroker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "publish_page",
      execute: publishExecute,
    });

    // If no credential found, return a structured error so the client can
    // trigger the assistant-driven token setup flow instead of blocking on
    // a vault dialog.
    if (
      !useResult.success &&
      useResult.reason?.includes("No credential found")
    ) {
      ctx.send(socket, {
        type: "publish_page_response",
        success: false,
        error: "Vercel API token not configured",
        errorCode: "credentials_missing",
      });
      return;
    }

    if (useResult.success && useResult.result) {
      ctx.send(socket, {
        type: "publish_page_response",
        success: true,
        publicUrl: useResult.result.url,
        deploymentId: useResult.result.deploymentId,
      });
    } else {
      log.error({ reason: useResult.reason }, "Failed to publish page");
      ctx.send(socket, {
        type: "publish_page_response",
        success: false,
        error: useResult.reason ?? "Failed to publish page",
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to publish page");
    ctx.send(socket, {
      type: "publish_page_response",
      success: false,
      error: message,
    });
  }
}

export async function handleUnpublishPage(
  msg: UnpublishPageRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const useResult = await credentialBroker.serverUse({
      service: "vercel",
      field: "api_token",
      toolName: "unpublish_page",
      execute: async (token) => {
        await deleteVercelDeployment(msg.deploymentId, token);

        const record = getPublishedPageByDeploymentId(msg.deploymentId);
        if (record) {
          markDeleted(record.id);
        }
      },
    });

    if (useResult.success) {
      ctx.send(socket, {
        type: "unpublish_page_response",
        success: true,
      });
    } else {
      log.error(
        { reason: useResult.reason, deploymentId: msg.deploymentId },
        "Failed to unpublish page",
      );
      ctx.send(socket, {
        type: "unpublish_page_response",
        success: false,
        error: useResult.reason ?? "Failed to unpublish page",
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, deploymentId: msg.deploymentId },
      "Failed to unpublish page",
    );
    ctx.send(socket, {
      type: "unpublish_page_response",
      success: false,
      error: message,
    });
  }
}

export const publishHandlers = defineHandlers({
  publish_page: handlePublishPage,
  unpublish_page: handleUnpublishPage,
});
