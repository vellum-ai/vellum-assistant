/**
 * Gateway proxy endpoints for channel verification session control-plane routes.
 *
 * These routes remain available even when the broad runtime proxy is
 * disabled, so skills and clients can use gateway URLs exclusively.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { getRootDir } from "../../credential-reader.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { stripHopByHop } from "../../util/strip-hop-by-hop.js";

const log = getLogger("channel-verification-session-proxy");

export function createChannelVerificationSessionProxyHandler(
  config: GatewayConfig,
) {
  let guardianInitInFlight = false;

  async function proxyToRuntime(
    req: Request,
    upstreamPath: string,
    upstreamSearch: string,
    clientIp?: string,
  ): Promise<Response> {
    const start = performance.now();
    const upstream = `${config.assistantRuntimeBaseUrl}${upstreamPath}${upstreamSearch}`;

    const reqHeaders = stripHopByHop(new Headers(req.headers));
    reqHeaders.delete("host");
    reqHeaders.delete("authorization");

    // Inject the real client IP so the runtime can enforce loopback-only
    // checks, overwriting any client-supplied value to prevent spoofing.
    if (clientIp) {
      reqHeaders.set("x-forwarded-for", clientIp);
    }

    // Mint a short-lived service token for gateway->runtime auth.
    // The token itself proves gateway origin (aud=vellum-daemon).
    reqHeaders.set("authorization", `Bearer ${mintServiceToken()}`);

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const bodyBuffer = hasBody ? await req.arrayBuffer() : null;
    if (bodyBuffer !== null) {
      reqHeaders.set("content-length", String(bodyBuffer.byteLength));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
    }, config.runtimeTimeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(upstream, {
        method: req.method,
        headers: reqHeaders,
        body: bodyBuffer,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      const duration = Math.round(performance.now() - start);
      if (err instanceof DOMException && err.name === "TimeoutError") {
        log.error(
          { path: upstreamPath, duration },
          "Channel verification session proxy upstream timed out",
        );
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error(
        { err, path: upstreamPath, duration },
        "Channel verification session proxy upstream connection failed",
      );
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    const resHeaders = stripHopByHop(new Headers(response.headers));
    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      const body = await response.text();
      log.warn(
        { path: upstreamPath, status: response.status, duration },
        "Channel verification session proxy upstream error",
      );
      return new Response(body, {
        status: response.status,
        headers: resHeaders,
      });
    }

    log.info(
      { path: upstreamPath, status: response.status, duration },
      "Channel verification session proxy completed",
    );
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders,
    });
  }

  return {
    async handleCreateVerificationSession(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/channel-verification-sessions", "");
    },

    async handleResendVerificationSession(req: Request): Promise<Response> {
      return proxyToRuntime(
        req,
        "/v1/channel-verification-sessions/resend",
        "",
      );
    },

    async handleCancelVerificationSession(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/channel-verification-sessions", "");
    },

    async handleRevokeVerificationBinding(req: Request): Promise<Response> {
      return proxyToRuntime(
        req,
        "/v1/channel-verification-sessions/revoke",
        "",
      );
    },

    async handleGetVerificationStatus(req: Request): Promise<Response> {
      const url = new URL(req.url);
      return proxyToRuntime(
        req,
        "/v1/channel-verification-sessions/status",
        url.search,
      );
    },

    async handleGuardianInit(
      req: Request,
      clientIp?: string,
    ): Promise<Response> {
      const lockPath = join(getRootDir(), "guardian-init.lock");
      if (existsSync(lockPath) || guardianInitInFlight) {
        log.warn("Guardian init rejected — already bootstrapped");
        return Response.json(
          { error: "Bootstrap already completed" },
          { status: 403 },
        );
      }

      guardianInitInFlight = true;
      try {
        const response = await proxyToRuntime(
          req,
          "/v1/guardian/init",
          "",
          clientIp,
        );

        if (response.status >= 200 && response.status < 300) {
          try {
            writeFileSync(lockPath, new Date().toISOString(), {
              mode: 0o600,
            });
          } catch (err) {
            log.error({ err }, "Failed to write guardian-init lock file");
          }
        } else {
          guardianInitInFlight = false;
        }

        return response;
      } catch (err) {
        guardianInitInFlight = false;
        throw err;
      }
    },

    async handleGuardianRefresh(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/guardian/refresh", "");
    },
  };
}
