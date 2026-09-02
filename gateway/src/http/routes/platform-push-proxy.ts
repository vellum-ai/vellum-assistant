/**
 * Proxy Django-owned device and Live Activity token routes.
 *
 * Remote-gateway clients register APNs/FCM and ActivityKit tokens on
 * `/v1/assistants/{id}/push-tokens/` and
 * `/v1/assistants/{id}/live-activity/tokens/`. Those paths are not daemon
 * routes. Without this handler they fall through to the runtime-proxy
 * catch-all and 404.
 *
 * The stored platform assistant UUID is used on the upstream path, not the
 * URL id (which may be `"self"` or a client-resolved slug). Django
 * authenticates the hop with the stored assistant API key.
 */

import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { getPlatformBaseUrl } from "../../platform-url.js";
import { errorResponse } from "../loopback-guard.js";

const log = getLogger("platform-push-proxy");

const UPSTREAM_TIMEOUT_MS = 10_000;

interface PlatformTarget {
  platformBaseUrl: string;
  assistantApiKey: string;
  assistantId: string;
}

export function createPlatformPushProxyHandler(credentials: CredentialCache) {
  async function resolvePlatformTarget(): Promise<PlatformTarget | Response> {
    const [platformBaseUrl, assistantApiKeyRaw, assistantIdRaw] =
      await Promise.all([
        getPlatformBaseUrl(credentials),
        credentials.get(credentialKey("vellum", "assistant_api_key")),
        credentials.get(credentialKey("vellum", "platform_assistant_id")),
      ]);

    const assistantApiKey = assistantApiKeyRaw?.trim() || undefined;
    const assistantId = assistantIdRaw?.trim() || undefined;

    if (!platformBaseUrl || !assistantApiKey || !assistantId) {
      return errorResponse(
        "PLATFORM_UNAVAILABLE",
        "This assistant is not registered with the Vellum platform, so push notifications are unavailable.",
        503,
      );
    }

    return { platformBaseUrl, assistantApiKey, assistantId };
  }

  async function forward(
    req: Request,
    resourcePath: string,
  ): Promise<Response> {
    const target = await resolvePlatformTarget();
    if (target instanceof Response) {
      return target;
    }

    const search = new URL(req.url).search;
    const upstreamUrl = `${target.platformBaseUrl}/v1/assistants/${target.assistantId}${resourcePath}${search}`;

    const headers = new Headers();
    headers.set("Authorization", `Api-Key ${target.assistantApiKey}`);
    const contentType = req.headers.get("content-type");
    if (contentType) {
      headers.set("Content-Type", contentType);
    }

    let body: ArrayBuffer | undefined;
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.method !== "DELETE"
    ) {
      body = await req.arrayBuffer();
    }

    try {
      const res = await fetchImpl(upstreamUrl, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      if (!res.ok) {
        log.warn(
          { status: res.status, path: resourcePath },
          "Non-OK response from platform push token endpoint",
        );
      }

      const responseHeaders = new Headers();
      const upstreamContentType = res.headers.get("content-type");
      if (upstreamContentType) {
        responseHeaders.set("content-type", upstreamContentType);
      }

      return new Response(res.body, {
        status: res.status,
        headers: responseHeaders,
      });
    } catch (err) {
      log.warn(
        { err, path: resourcePath },
        "Failed to reach platform push token endpoint",
      );
      return errorResponse(
        "PLATFORM_UNAVAILABLE",
        "Could not reach the Vellum platform to register this device.",
        502,
      );
    }
  }

  return {
    handleUpsertPushToken(req: Request): Promise<Response> {
      return forward(req, "/push-tokens/");
    },

    handleDeletePushToken(req: Request, token: string): Promise<Response> {
      return forward(req, `/push-tokens/${encodeURIComponent(token)}/`);
    },

    handleUpsertLiveActivityToken(req: Request): Promise<Response> {
      return forward(req, "/live-activity/tokens/");
    },

    handleDeleteLiveActivityToken(
      req: Request,
      token: string,
    ): Promise<Response> {
      return forward(req, `/live-activity/tokens/${encodeURIComponent(token)}/`);
    },
  };
}
