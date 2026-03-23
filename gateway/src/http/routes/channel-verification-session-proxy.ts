/**
 * Gateway proxy endpoints for channel verification session control-plane routes.
 *
 * These routes remain available even when the broad runtime proxy is
 * disabled, so skills and clients can use gateway URLs exclusively.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { getRootDir } from "../../credential-reader.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { stripHopByHop } from "../../util/strip-hop-by-hop.js";

const log = getLogger("channel-verification-session-proxy");

/**
 * Parse the set of valid bootstrap secrets from GUARDIAN_BOOTSTRAP_SECRET.
 *
 * The env var may contain a single secret or a comma-separated list when
 * multiple clients need to independently bootstrap (e.g. a remote VM and
 * the local laptop that initiated the hatch). Each secret is one-time-use;
 * the gateway locks the endpoint once every expected secret has been consumed.
 *
 * Returns an empty set when the env var is unset (bare-metal mode).
 */
function parseBootstrapSecrets(): Set<string> {
  const raw = process.env.GUARDIAN_BOOTSTRAP_SECRET;
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function createChannelVerificationSessionProxyHandler(
  config: GatewayConfig,
) {
  let guardianInitInFlight = false;
  const secretsInFlight = new Set<string>();

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
      const lockDir = process.env.GATEWAY_SECURITY_DIR || getRootDir();
      const lockPath = join(lockDir, "guardian-init.lock");
      const consumedPath = join(lockDir, "guardian-init-consumed.json");

      const expectedSecrets = parseBootstrapSecrets();
      const provided = req.headers.get("x-bootstrap-secret");

      if (expectedSecrets.size > 0) {
        // Docker mode: require a valid, unconsumed bootstrap secret.
        if (!provided || !expectedSecrets.has(provided)) {
          log.warn(
            "Guardian init rejected — invalid or missing bootstrap secret",
          );
          return Response.json(
            { error: "Invalid bootstrap secret" },
            { status: 403 },
          );
        }

        // In-memory guard: reject if this secret is already being processed
        // by a concurrent request (prevents double-mint across the await).
        if (secretsInFlight.has(provided)) {
          log.warn("Guardian init rejected — bootstrap secret already used");
          return Response.json(
            { error: "Bootstrap secret already used" },
            { status: 403 },
          );
        }

        // Load the set of already-consumed secrets from disk.
        let consumed: string[] = [];
        try {
          if (existsSync(consumedPath)) {
            consumed = JSON.parse(
              readFileSync(consumedPath, "utf-8"),
            ) as string[];
          }
        } catch {
          // Treat corrupt file as empty — allow the init to proceed.
        }

        if (consumed.includes(provided)) {
          log.warn("Guardian init rejected — bootstrap secret already used");
          return Response.json(
            { error: "Bootstrap secret already used" },
            { status: 403 },
          );
        }

        // Final lock check: if every secret has been consumed the
        // lock file should already exist, but check defensively.
        if (existsSync(lockPath)) {
          log.warn("Guardian init rejected — already bootstrapped");
          return Response.json(
            { error: "Bootstrap already completed" },
            { status: 403 },
          );
        }
      } else {
        // Bare-metal mode: one-time-use lockfile guard.
        if (existsSync(lockPath) || guardianInitInFlight) {
          log.warn("Guardian init rejected — already bootstrapped");
          return Response.json(
            { error: "Bootstrap already completed" },
            { status: 403 },
          );
        }
      }

      guardianInitInFlight = true;
      if (provided) {
        secretsInFlight.add(provided);
      }
      try {
        const response = await proxyToRuntime(
          req,
          "/v1/guardian/init",
          "",
          clientIp,
        );

        if (response.status >= 200 && response.status < 300) {
          if (expectedSecrets.size > 0 && provided) {
            // Record this secret as consumed.
            let consumed: string[] = [];
            try {
              if (existsSync(consumedPath)) {
                consumed = JSON.parse(
                  readFileSync(consumedPath, "utf-8"),
                ) as string[];
              }
            } catch {
              // Treat corrupt file as empty.
            }
            consumed.push(provided);
            try {
              writeFileSync(consumedPath, JSON.stringify(consumed) + "\n", {
                mode: 0o600,
              });
            } catch (err) {
              log.error({ err }, "Failed to write consumed secrets file");
            }

            // Write the lock file once every expected secret has been used.
            const allConsumed = [...expectedSecrets].every((s) =>
              consumed.includes(s),
            );
            if (allConsumed) {
              try {
                writeFileSync(lockPath, new Date().toISOString(), {
                  mode: 0o600,
                });
              } catch (err) {
                log.error({ err }, "Failed to write guardian-init lock file");
              }
            }
          } else {
            // Bare-metal mode: lock immediately after first success.
            try {
              writeFileSync(lockPath, new Date().toISOString(), {
                mode: 0o600,
              });
            } catch (err) {
              log.error({ err }, "Failed to write guardian-init lock file");
            }
          }
        } else {
          guardianInitInFlight = false;
        }

        return response;
      } catch (err) {
        guardianInitInFlight = false;
        throw err;
      } finally {
        if (provided) {
          secretsInFlight.delete(provided);
        }
      }
    },

    async handleGuardianRefresh(req: Request): Promise<Response> {
      return proxyToRuntime(req, "/v1/guardian/refresh", "");
    },
  };
}
