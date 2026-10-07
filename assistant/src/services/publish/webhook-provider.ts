/**
 * Generic HTTP publish provider.
 *
 * POSTs the compiled app plus its metadata as JSON to a user-configured
 * endpoint and expects `{ url, deploymentId }` back, so any PaaS (Coolify,
 * Dokku, Fly, Cloudflare, a plain nginx box) can be targeted through a small
 * shim the user controls. The bearer token, when there is one, comes from the
 * credential store; `apps.publish.webhook.*` holds only the endpoint shape.
 */

import { z } from "zod";

import { getIsPlatform } from "../../config/env-registry.js";
import { getConfig } from "../../config/loader.js";
import type { PublishWebhookConfig } from "../../config/schemas/apps.js";
import {
  isPrivateOrLocalHost,
  resolveHostAddresses,
  resolveRequestAddress,
} from "../../tools/network/url-safety.js";
import { ProviderError } from "../../util/errors.js";
import type {
  AppPublishMeta,
  PublishProvider,
  PublishResult,
} from "./types.js";

/** Longest error body echoed back to the caller. */
const MAX_ERROR_BODY_CHARS = 500;

const WebhookResponseSchema = z.object({
  url: z.string().min(1),
  deploymentId: z.string().min(1),
});

/**
 * Validate a configured endpoint and reject one that would reach a private
 * address. The private-address check only applies on platform-hosted daemons,
 * where the container runs on Vellum infrastructure: a self-hosted daemon runs
 * on the user's own machine, so a PaaS on localhost or the LAN is the expected
 * target (matching the custom inference base-url rule).
 */
export async function resolveWebhookEndpoint(
  rawUrl: string,
  configKey: string,
): Promise<URL> {
  if (!rawUrl) {
    throw new ProviderError(
      `${configKey} is not set. Point it at an endpoint that accepts the publish payload.`,
      "webhook",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ProviderError(
      `${configKey} must be a valid http(s) URL`,
      "webhook",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProviderError(`${configKey} must be an http(s) URL`, "webhook");
  }

  if (getIsPlatform()) {
    if (isPrivateOrLocalHost(parsed.hostname)) {
      throw new ProviderError(
        `${configKey} must not point to a private or local network address`,
        "webhook",
      );
    }
    const resolved = await resolveRequestAddress(
      parsed.hostname,
      resolveHostAddresses,
      /* allowPrivateNetwork */ false,
    );
    if (resolved.blockedAddress) {
      throw new ProviderError(
        `${configKey} resolves to a private network address`,
        "webhook",
      );
    }
  }

  return parsed;
}

function webhookConfig(): PublishWebhookConfig {
  return getConfig().apps.publish.webhook;
}

function headers(token: string | null): Record<string, string> {
  const result: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (token) {
    result.Authorization = `Bearer ${token}`;
  }
  return result;
}

/**
 * Redirects are not followed. The address check above runs against the
 * configured endpoint, and following a redirect would let that endpoint hand
 * the request to an address the check would have refused. A 3xx therefore
 * falls through to the ordinary non-2xx error with its status attached.
 */
const REDIRECT_POLICY = "manual" as const;

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return "";
  }
}

export const webhookPublishProvider: PublishProvider = {
  id: "webhook",
  displayName: "Webhook",
  credential: {
    service: "publish_webhook",
    field: "token",
    required: false,
    missingMessage:
      "Publish webhook bearer token is not stored. Store it as publish_webhook/token or leave it unset for an unauthenticated endpoint.",
  },

  async deploy(
    html: string,
    meta: AppPublishMeta,
    token: string | null,
  ): Promise<PublishResult> {
    const config = webhookConfig();
    const endpoint = await resolveWebhookEndpoint(
      config.url,
      "apps.publish.webhook.url",
    );

    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        appId: meta.appId,
        name: meta.name,
        slug: meta.slug,
        previousDeploymentId: meta.previousDeploymentId ?? null,
        html,
      }),
      redirect: REDIRECT_POLICY,
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      throw new ProviderError(
        `Publish webhook failed (${response.status}): ${await readErrorBody(response)}`,
        "webhook",
        response.status,
      );
    }

    const parsed = WebhookResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new ProviderError(
        'Publish webhook returned an unexpected body. Expected JSON {"url": "...", "deploymentId": "..."}.',
        "webhook",
      );
    }

    return { url: parsed.data.url, deploymentId: parsed.data.deploymentId };
  },

  async unpublish(meta: AppPublishMeta, token: string | null): Promise<void> {
    const config = webhookConfig();
    const target = config.unpublishUrl || config.url;
    const endpoint = await resolveWebhookEndpoint(
      target,
      config.unpublishUrl
        ? "apps.publish.webhook.unpublishUrl"
        : "apps.publish.webhook.url",
    );

    const response = await fetch(endpoint, {
      method: config.unpublishMethod,
      headers: headers(token),
      body: JSON.stringify({
        appId: meta.appId,
        name: meta.name,
        slug: meta.slug,
        deploymentId: meta.previousDeploymentId ?? null,
      }),
      redirect: REDIRECT_POLICY,
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      throw new ProviderError(
        `Unpublish webhook failed (${response.status}): ${await readErrorBody(response)}`,
        "webhook",
        response.status,
      );
    }
  },
};
