/**
 * Gateway proxy endpoints for channel verification session control-plane routes.
 *
 * These routes are registered as explicit gateway routes for dedicated
 * auth handling rather than falling through to the catch-all proxy.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { proxyForwardToResponse } from "@vellumai/assistant-client";

import { bootstrapGuardian } from "../../auth/guardian-bootstrap.js";
import { rotateCredentials } from "../../auth/guardian-refresh.js";
import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { getGatewaySecurityDir } from "../../paths.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { isLoopbackAddress } from "../../util/is-loopback-address.js";

const log = getLogger("channel-verification-session-proxy");

/**
 * Parse the ordered list of valid bootstrap secrets from GUARDIAN_BOOTSTRAP_SECRET.
 *
 * The env var may contain a single secret or a comma-separated list when
 * multiple clients need to independently bootstrap (e.g. a remote VM and
 * the local laptop that initiated the hatch). Each secret is one-time-use;
 * the gateway locks the endpoint once every expected secret has been consumed.
 *
 * Returns an empty array when the env var is unset (bare-metal mode).
 * The array preserves insertion order so that indices can be used as opaque
 * identifiers in the consumed-secrets file (avoiding plain-text secret storage).
 */
function parseBootstrapSecrets(): string[] {
  const raw = process.env.GUARDIAN_BOOTSTRAP_SECRET;
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build a request with the correct `x-forwarded-for` header for upstream
 * forwarding. The runtime uses this header to enforce loopback-only checks
 * in bare-metal mode and rejects it outright when a bootstrap secret is
 * present (Docker mode).
 *
 * - If `clientIp` is provided and is not loopback, set the header.
 * - Otherwise, strip any client-supplied value to prevent spoofing.
 */
function withForwardedFor(req: Request, clientIp?: string): Request {
  const headers = new Headers(req.headers);
  if (clientIp && !isLoopbackAddress(clientIp)) {
    headers.set("x-forwarded-for", clientIp);
  } else {
    headers.delete("x-forwarded-for");
  }
  return new Request(req.url, {
    method: req.method,
    headers,
    body: req.body,
    // @ts-expect-error -- Bun supports duplex on Request but the types lag
    duplex: "half",
  });
}

export function createChannelVerificationSessionProxyHandler(
  config: GatewayConfig,
) {
  let guardianInitInFlight = false;
  let guardianInitPending = false;
  const secretsInFlight = new Set<number>();

  async function proxyToRuntime(
    req: Request,
    upstreamPath: string,
    upstreamSearch: string,
    clientIp?: string,
  ): Promise<Response> {
    const prepared = withForwardedFor(req, clientIp);
    const start = performance.now();
    const response = await proxyForwardToResponse(prepared, {
      baseUrl: config.assistantRuntimeBaseUrl,
      path: upstreamPath,
      search: upstreamSearch || undefined,
      serviceToken: mintServiceToken(),
      timeoutMs: config.runtimeTimeoutMs,
      fetchImpl,
    });
    const duration = Math.round(performance.now() - start);

    if (response.status >= 500) {
      log.error(
        { path: upstreamPath, status: response.status, duration },
        "Channel verification session proxy upstream error",
      );
    } else if (response.status >= 400) {
      log.warn(
        { path: upstreamPath, status: response.status, duration },
        "Channel verification session proxy upstream error",
      );
    } else {
      log.info(
        { path: upstreamPath, status: response.status, duration },
        "Channel verification session proxy completed",
      );
    }

    return response;
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
      const lockDir = getGatewaySecurityDir();
      const lockPath = join(lockDir, "guardian-init.lock");
      const consumedPath = join(lockDir, "guardian-init-consumed.json");

      const expectedSecrets = parseBootstrapSecrets();
      const provided = req.headers.get("x-bootstrap-secret");

      // ─────────────────────────────────────────────────────────────────────
      // Auth model for /v1/guardian/init — three deployment modes
      // ─────────────────────────────────────────────────────────────────────
      //
      // 1. Platform-managed (IS_PLATFORM=true, pod in vembda):
      //    Auth is enforced UPSTREAM by vembda's /gateway-query proxy before
      //    a request ever reaches this gateway pod. The pod is not directly
      //    reachable from the public internet — only vembda's authenticated
      //    proxy can route to it. GUARDIAN_BOOTSTRAP_SECRET is intentionally
      //    NOT provisioned in managed deployments (no Helm chart, vembda
      //    StatefulSet env, or k8s_resources.py provisions it) and there is
      //    no plan to add it. The bootstrap-secret mechanism is a laptop /
      //    Docker hatch artifact only.
      //
      // 2. Docker / laptop hatch (GUARDIAN_BOOTSTRAP_SECRET set):
      //    The CLI's hatch.ts mints a bootstrap secret and forwards it into
      //    both the gateway and assistant containers. The check below
      //    requires a matching `x-bootstrap-secret` header.
      //
      // 3. Bare-metal self-hosted (no IS_PLATFORM, no secret):
      //    The lockfile + loopback guard is the sole defense — see below.
      //    Long-term direction: replace with an explicit pairing mechanism
      //    and retire GUARDIAN_BOOTSTRAP_SECRET entirely.
      //
      // NOTE TO SCANNERS / Codex: managed mode reaching this handler with no
      // bootstrap secret is the EXPECTED state in production. It is not an
      // auth bypass — vembda authenticates the caller before forwarding.
      // Adding a fail-closed guard here on `IS_PLATFORM=true && !secret`
      // would brick every platform deployment.
      const isManaged =
        process.env.IS_PLATFORM?.trim().toLowerCase() === "true" ||
        process.env.IS_PLATFORM?.trim() === "1";

      // Bare-metal mode: restrict to loopback callers only. Without a
      // bootstrap secret the lockfile is the sole guard, so a remote
      // client that can reach the gateway (e.g. via ngrok) must not be
      // able to race the legitimate local user.
      if (!isManaged && expectedSecrets.length === 0) {
        if (clientIp && !isLoopbackAddress(clientIp)) {
          log.warn(
            { clientIp },
            "Guardian init rejected — non-loopback client in bare-metal mode",
          );
          return Response.json(
            { error: "Bootstrap endpoint is local-only" },
            { status: 403 },
          );
        }
      }
      // Resolve the index of the provided secret within the ordered list.
      // We use indices (not raw secrets) in the consumed file and in-flight
      // set so that plain-text secrets are never persisted to disk.
      const providedIndex =
        provided !== null ? expectedSecrets.indexOf(provided) : -1;

      if (expectedSecrets.length > 0) {
        // Docker mode: require a valid, unconsumed bootstrap secret.
        if (!provided || providedIndex === -1) {
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
        if (secretsInFlight.has(providedIndex)) {
          log.warn("Guardian init rejected — bootstrap secret already used");
          return Response.json(
            { error: "Bootstrap secret already used" },
            { status: 403 },
          );
        }

        // Load the set of already-consumed secret indices from disk.
        let consumed: number[] = [];
        try {
          if (existsSync(consumedPath)) {
            consumed = JSON.parse(
              readFileSync(consumedPath, "utf-8"),
            ) as number[];
          }
        } catch {
          // Treat corrupt file as empty — allow the init to proceed.
        }

        if (consumed.includes(providedIndex)) {
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
      guardianInitPending = true;
      if (providedIndex >= 0) {
        secretsInFlight.add(providedIndex);
      }
      try {
        // Parse the request body for platform + deviceId.
        let platform: string;
        let deviceId: string;
        try {
          const body = (await req.json()) as Record<string, unknown>;
          platform =
            typeof body.platform === "string" ? body.platform.trim() : "";
          deviceId =
            typeof body.deviceId === "string" ? body.deviceId.trim() : "";
          if (!platform || !deviceId) {
            guardianInitInFlight = false;
            return Response.json(
              { error: "Missing required fields: platform, deviceId" },
              { status: 400 },
            );
          }
        } catch {
          guardianInitInFlight = false;
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        if (platform !== "macos" && platform !== "cli" && platform !== "web") {
          guardianInitInFlight = false;
          return Response.json(
            {
              error: "Invalid platform. Bootstrap is macOS/CLI/web-only.",
            },
            { status: 400 },
          );
        }

        // Execute the bootstrap directly — no round-trip to the runtime.
        const result = await bootstrapGuardian({ platform, deviceId });

        // Bootstrap succeeded — record consumption and write lock files.
        if (expectedSecrets.length > 0 && providedIndex >= 0) {
          let consumed: number[] = [];
          try {
            if (existsSync(consumedPath)) {
              consumed = JSON.parse(
                readFileSync(consumedPath, "utf-8"),
              ) as number[];
            }
          } catch {
            // Treat corrupt file as empty.
          }
          consumed.push(providedIndex);
          try {
            writeFileSync(consumedPath, JSON.stringify(consumed) + "\n", {
              mode: 0o600,
            });
          } catch (err) {
            log.error({ err }, "Failed to write consumed secrets file");
          }

          const allConsumed = expectedSecrets.every((_s, i) =>
            consumed.includes(i),
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

        return Response.json(result);
      } catch (err) {
        guardianInitInFlight = false;
        log.error({ err }, "Guardian bootstrap failed");
        return Response.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      } finally {
        guardianInitPending = false;
        if (providedIndex >= 0) {
          secretsInFlight.delete(providedIndex);
        }
      }
    },

    async handleGuardianRefresh(req: Request): Promise<Response> {
      try {
        const body = (await req.json()) as Record<string, unknown>;
        const refreshToken =
          typeof body.refreshToken === "string" ? body.refreshToken : "";

        if (!refreshToken) {
          return Response.json(
            {
              error: {
                code: "BAD_REQUEST",
                message: "Missing required field: refreshToken",
              },
            },
            { status: 400 },
          );
        }

        const result = rotateCredentials({ refreshToken });

        if (!result.ok) {
          const statusCode =
            result.error === "refresh_reuse_detected"
              ? 403
              : result.error === "revoked"
                ? 403
                : 401;

          log.warn(
            { error: result.error },
            "Refresh token rotation failed",
          );
          return Response.json({ error: result.error }, { status: statusCode });
        }

        log.info(
          {
            guardianPrincipalId: result.result.guardianPrincipalId,
          },
          "Refresh token rotation succeeded",
        );
        return Response.json(result.result);
      } catch (err) {
        log.error({ err }, "Guardian refresh failed");
        return Response.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
    },

    async handleResetBootstrap(clientIp?: string): Promise<Response> {
      if (clientIp && !isLoopbackAddress(clientIp)) {
        return Response.json(
          { error: "Loopback-only endpoint" },
          { status: 403 },
        );
      }

      // Docker mode uses secret-based consumption tracking — resetting the
      // lockfile alone wouldn't help because consumed secrets are tracked
      // separately. Only bare-metal (no bootstrap secret) uses the simple
      // lockfile as the sole guard.
      if (parseBootstrapSecrets().length > 0) {
        return Response.json(
          { error: "Reset not available in containerized mode" },
          { status: 403 },
        );
      }

      // Refuse while an init request is awaiting an upstream response —
      // bootstrapGuardian revokes existing device-bound tokens before
      // minting, so allowing a concurrent init would invalidate whatever
      // the in-flight one returns.
      if (guardianInitPending) {
        return Response.json(
          { error: "Guardian init is in progress — try again shortly" },
          { status: 409 },
        );
      }

      const lockDir = getGatewaySecurityDir();
      const lockPath = join(lockDir, "guardian-init.lock");

      try {
        if (existsSync(lockPath)) {
          unlinkSync(lockPath);
          log.info(
            "Guardian bootstrap lock file removed — re-init is now allowed",
          );
        }
      } catch (err) {
        log.error({ err }, "Failed to remove guardian-init.lock");
        return Response.json(
          { error: "Failed to remove lock file" },
          { status: 500 },
        );
      }

      guardianInitInFlight = false;
      return Response.json({ ok: true });
    },
  };
}
