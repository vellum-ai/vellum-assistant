import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Plugin, Connect, ViteDevServer } from "vite";

import {
  resolveLocalConfigFromEnv,
  resolveDevCliInvocation,
  isLoopbackAddr,
  headerHostIsLoopback,
  originIsAllowed,
  getLockfileData,
  getLocalAssistantStatus,
  upsertLockfileAssistant,
  replacePlatformAssistants,
  isActiveAssistant,
  runHatch,
  runRetire,
  runSleep,
  runUpgrade,
  runWake,
  getGuardianAccessToken,
  resolveGatewayProxyTarget,
  readAllowedGatewayPorts,
  type CliInvocation,
} from "@vellumai/local-mode";

const GUARDIAN_TOKEN_PATTERN =
  /^(?:\/assistant)?\/__local\/guardian-token\/([^/]+)$/;
const LOCAL_STATUS_PATTERN = /^(?:\/assistant)?\/__local\/status\/([^/]+)$/;
const LOCAL_UPGRADE_PATTERN = /^(?:\/assistant)?\/__local\/upgrade$/;
const PLATFORM_SESSION_PATTERN =
  /^(?:\/assistant)?\/__local\/platform-session$/;

// In-memory loopback platform session token for the dev server. The proxy
// (vite.config.ts) and the middleware below run in the same Node process, so
// this module singleton bridges them. Dev-only and session-scoped; the
// installed CLI persists the token via its own store.
let devPlatformToken: string | null = null;
export function getDevPlatformToken(): string | null {
  return devPlatformToken;
}

/**
 * Whether a proxied request is same-origin SPA traffic that may carry the
 * platform credential. A cross-site page must not be able to use the dev proxy
 * as a confused deputy. Mirrors the Bun server's check.
 */
export function isSameOriginProxyRequest(req: http.IncomingMessage): boolean {
  const origin = Array.isArray(req.headers.origin)
    ? req.headers.origin[0]
    : req.headers.origin;
  if (!originIsAllowed(origin)) return false;
  const site = req.headers["sec-fetch-site"];
  const siteValue = Array.isArray(site) ? site[0] : site;
  return !siteValue || siteValue === "same-origin" || siteValue === "none";
}

export function localModePlugin(env: Record<string, string>): Plugin {
  const config = resolveLocalConfigFromEnv(env);
  const baseDir = path.resolve(import.meta.dirname, "..", "..");

  const configJson = JSON.stringify({
    webUrl: config.webUrl,
    platformUrl: config.platformUrl,
  });

  return {
    name: "vellum-local-mode",
    transformIndexHtml(html) {
      return html.replace(
        "</head>",
        `<script>window.__VELLUM_CONFIG__=${configJson}</script></head>`,
      );
    },
    configureServer(server) {
      server.middlewares.use(loopbackCallbackMiddleware());
      server.middlewares.use(platformSessionMiddleware());
      server.middlewares.use(
        configMiddleware(config.webUrl, config.platformUrl),
      );
      server.middlewares.use(lockfileMiddleware(config.lockfilePaths));
      server.middlewares.use(hatchMiddleware(baseDir));
      server.middlewares.use(retireMiddleware(baseDir, config.lockfilePaths));
      server.middlewares.use(sleepMiddleware(baseDir));
      server.middlewares.use(wakeMiddleware(baseDir));
      const upgradingLocalAssistantIds = new Set<string>();
      server.middlewares.use(
        upgradeMiddleware(
          baseDir,
          config.lockfilePaths,
          upgradingLocalAssistantIds,
        ),
      );
      server.middlewares.use(
        statusMiddleware(config.lockfilePaths, upgradingLocalAssistantIds),
      );
      server.middlewares.use(
        guardianTokenMiddleware(config.configDir, baseDir, env),
      );
      server.middlewares.use(gatewayProxyMiddleware(config.lockfilePaths));
      server.middlewares.use(accountSpaFallback(server));
    },
  };
}

function rejectUnlessLocalEndpointRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const peer = req.socket.remoteAddress ?? "";
  const host = Array.isArray(req.headers.host)
    ? req.headers.host[0]
    : req.headers.host;
  const origin = Array.isArray(req.headers.origin)
    ? req.headers.origin[0]
    : req.headers.origin;
  if (
    !isLoopbackAddr(peer) ||
    !headerHostIsLoopback(host) ||
    !originIsAllowed(origin)
  ) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return true;
  }
  return false;
}

function loopbackCallbackMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.url?.startsWith("/callback")) {
      const qs = req.url.slice("/callback".length);
      res.writeHead(302, { Location: `/account/platform-callback${qs}` });
      res.end();
      return;
    }
    next();
  };
}

// Receives the loopback platform session token from the SPA (after it has
// validated the `state` nonce) and holds it for the proxy. Mirrors the Bun
// server's /__local/platform-session endpoint.
function platformSessionMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const path = (req.url ?? "").split("?")[0];
    if (!PLATFORM_SESSION_PATTERN.test(path)) return next();
    if (rejectUnlessLocalEndpointRequest(req, res)) return;

    if (req.method === "DELETE") {
      devPlatformToken = null;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let token: unknown;
      try {
        token = (
          JSON.parse(Buffer.concat(chunks).toString()) as { token?: unknown }
        ).token;
      } catch {
        token = undefined;
      }
      if (typeof token !== "string" || !/^[A-Za-z0-9]+$/.test(token)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "Invalid token" }));
        return;
      }
      devPlatformToken = token;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  };
}

function configMiddleware(
  webUrl: string,
  platformUrl: string,
): Connect.NextHandleFunction {
  const body = JSON.stringify({ webUrl, platformUrl });

  return (req, res, next) => {
    if (req.url !== "/assistant/__config" && req.url !== "/__config")
      return next();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  };
}

function accountSpaFallback(server: ViteDevServer): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (
      !req.url?.startsWith("/account/") &&
      !req.url?.startsWith("/account?") &&
      req.url !== "/account"
    )
      return next();

    const indexPath = path.join(server.config.root, "index.html");
    fs.readFile(indexPath, "utf-8", (err, html) => {
      if (err) return next(err);
      server
        .transformIndexHtml(req.url!, html)
        .then((transformed) => {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(transformed);
        })
        .catch(next);
    });
  };
}

function lockfileMiddleware(
  lockfilePaths: string[],
): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (
      req.url !== "/assistant/__local/lockfile" &&
      req.url !== "/__local/lockfile"
    )
      return next();

    if (rejectUnlessLocalEndpointRequest(req, res)) return;

    if (req.method === "GET") {
      const result = getLockfileData(lockfilePaths);
      if (result.ok) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.data));
      } else {
        res.statusCode = result.status;
        res.end();
      }
    } else if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
            string,
            unknown
          >;
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          return;
        }

        let result;
        if (body.syncPlatform && Array.isArray(body.platformAssistants)) {
          result = replacePlatformAssistants(
            lockfilePaths,
            body.platformAssistants as Array<Record<string, unknown>>,
            body.organizationId as string | undefined,
          );
        } else {
          result = upsertLockfileAssistant(
            lockfilePaths,
            body.assistant as Record<string, unknown>,
            body.activeAssistant as string | undefined,
          );
        }
        res.statusCode = result.ok ? 200 : result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      });
    } else {
      res.statusCode = 405;
      res.end();
    }
  };
}

function hatchMiddleware(baseDir: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.url !== "/assistant/__local/hatch" && req.url !== "/__local/hatch")
      return next();

    if (rejectUnlessLocalEndpointRequest(req, res)) return;

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let species = "vellum";
      let remote: string | undefined;
      if (chunks.length > 0) {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            species?: string;
            remote?: string;
          };
          if (body.species) species = body.species;
          if (body.remote) remote = body.remote;
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          return;
        }
      }

      let invocation: CliInvocation;
      try {
        invocation = resolveDevCliInvocation(baseDir, import.meta.url);
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }

      runHatch(invocation, species, remote ? { remote } : undefined).then(
        (result) => {
          res.statusCode = result.ok ? 200 : result.status;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify(
              result.ok
                ? { ok: true, assistantId: result.assistantId }
                : { ok: false, error: result.error },
            ),
          );
        },
      );
    });
  };
}

function retireMiddleware(
  baseDir: string,
  lockfilePaths: string[],
): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (
      req.url !== "/assistant/__local/retire" &&
      req.url !== "/__local/retire"
    )
      return next();

    if (rejectUnlessLocalEndpointRequest(req, res)) return;

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let assistantId: string | undefined;
      if (chunks.length > 0) {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            assistantId?: string;
          };
          assistantId = body.assistantId;
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          return;
        }
      }

      if (!assistantId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "Missing assistantId" }));
        return;
      }

      if (!isActiveAssistant(lockfilePaths, assistantId)) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: false,
            error: "Can only retire the active local assistant",
          }),
        );
        return;
      }

      let invocation: CliInvocation;
      try {
        invocation = resolveDevCliInvocation(baseDir, import.meta.url);
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }

      runRetire(invocation, assistantId, {
        platformToken: getDevPlatformToken() ?? undefined,
      }).then((result) => {
        res.statusCode = result.ok ? 200 : result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            result.ok ? { ok: true } : { ok: false, error: result.error },
          ),
        );
      });
    });
  };
}

function sleepMiddleware(baseDir: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (
      req.url !== "/assistant/__local/sleep" &&
      req.url !== "/__local/sleep"
    ) {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) return;

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let assistantId: string | undefined;
      if (chunks.length > 0) {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            assistantId?: string;
          };
          assistantId = body.assistantId;
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          return;
        }
      }

      if (!assistantId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "Missing assistantId" }));
        return;
      }

      let invocation: CliInvocation;
      try {
        invocation = resolveDevCliInvocation(baseDir, import.meta.url);
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }

      runSleep(invocation, assistantId).then((result) => {
        res.statusCode = result.ok ? 200 : result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            result.ok ? { ok: true } : { ok: false, error: result.error },
          ),
        );
      });
    });
  };
}

function wakeMiddleware(baseDir: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.url !== "/assistant/__local/wake" && req.url !== "/__local/wake")
      return next();

    if (rejectUnlessLocalEndpointRequest(req, res)) return;

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let assistantId: string | undefined;
      let repairGuardian = false;
      if (chunks.length > 0) {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            assistantId?: string;
            repairGuardian?: boolean;
          };
          assistantId = body.assistantId;
          repairGuardian = body.repairGuardian === true;
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          return;
        }
      }

      if (!assistantId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "Missing assistantId" }));
        return;
      }

      let invocation: CliInvocation;
      try {
        invocation = resolveDevCliInvocation(baseDir, import.meta.url);
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }

      runWake(invocation, assistantId, { repairGuardian }).then((result) => {
        res.statusCode = result.ok ? 200 : result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            result.ok ? { ok: true } : { ok: false, error: result.error },
          ),
        );
      });
    });
  };
}

function upgradeMiddleware(
  baseDir: string,
  lockfilePaths: string[],
  upgradingLocalAssistantIds: Set<string>,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!LOCAL_UPGRADE_PATTERN.test(req.url ?? "")) return next();

    if (rejectUnlessLocalEndpointRequest(req, res)) return;

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let assistantId: string | undefined;
      let latest = false;
      let force = false;
      let version: string | undefined;
      if (chunks.length > 0) {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            assistantId?: string;
            latest?: boolean;
            force?: boolean;
            version?: string;
          };
          assistantId = body.assistantId;
          latest = body.latest === true;
          force = body.force === true;
          version = body.version;
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          return;
        }
      }

      if (!assistantId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "Missing assistantId" }));
        return;
      }

      if (!isActiveAssistant(lockfilePaths, assistantId)) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: false,
            error: "Can only upgrade the active local assistant",
          }),
        );
        return;
      }

      if (upgradingLocalAssistantIds.has(assistantId)) {
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: false,
            error: "An upgrade is already in progress for this assistant.",
          }),
        );
        return;
      }

      let invocation: CliInvocation;
      try {
        invocation = resolveDevCliInvocation(baseDir, import.meta.url);
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }

      const options = {
        ...(latest ? { latest } : {}),
        ...(version ? { version } : {}),
        ...(force ? { force } : {}),
      };

      upgradingLocalAssistantIds.add(assistantId);
      runUpgrade(invocation, assistantId, options)
        .then((result) => {
          res.statusCode = result.ok ? 200 : result.status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result));
        })
        .finally(() => {
          upgradingLocalAssistantIds.delete(assistantId);
        });
    });
  };
}

function statusMiddleware(
  lockfilePaths: string[],
  upgradingLocalAssistantIds: Set<string>,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = req.url?.match(LOCAL_STATUS_PATTERN);
    if (!match) return next();

    if (rejectUnlessLocalEndpointRequest(req, res)) return;

    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const assistantId = decodeURIComponent(match[1]!);
    if (upgradingLocalAssistantIds.has(assistantId)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, state: "upgrading" }));
      return;
    }

    void getLocalAssistantStatus(lockfilePaths, assistantId).then((result) => {
      res.statusCode = result.ok ? 200 : result.status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    });
  };
}

function guardianTokenMiddleware(
  configDir: string,
  baseDir: string,
  env: Record<string, string>,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = req.url?.match(GUARDIAN_TOKEN_PATTERN);
    if (!match) return next();

    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end();
      return;
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) return;

    const assistantId = decodeURIComponent(match[1]!);

    let invocation: CliInvocation;
    try {
      invocation = resolveDevCliInvocation(baseDir, import.meta.url);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    getGuardianAccessToken(assistantId, configDir, invocation, true, env).then(
      (result) => {
        if (result.ok) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ accessToken: result.accessToken }));
        } else {
          res.statusCode = result.status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: result.error }));
        }
      },
    );
  };
}

function gatewayProxyMiddleware(
  lockfilePaths: string[],
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const decision = resolveGatewayProxyTarget(req.url ?? "", () =>
      readAllowedGatewayPorts(lockfilePaths),
    );
    if (decision.kind === "pass") return next();

    if (rejectUnlessLocalEndpointRequest(req, res)) return;

    if (decision.kind === "invalid-port") {
      res.statusCode = 400;
      res.end("Port must be between 1024 and 65535");
      return;
    }

    if (decision.kind === "forbidden-port") {
      res.statusCode = 403;
      res.end("Gateway port is not active in lockfile");
      return;
    }

    const { target } = decision;
    const proxyOptions: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: target.port,
      path: target.path,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${target.port}` },
    };

    const proxyReq = http.request(proxyOptions, (proxyRes) => {
      // Drop the upstream's `transfer-encoding` before re-emitting: Node's http
      // server sets its own when we pipe the streamed body, so copying the
      // gateway's `chunked` too yields a duplicate ("too many transfer
      // encodings"). A strict downstream proxy (the `vel up` Caddy edge)
      // rejects that with 502 — fatal for the SSE `/events` stream, whose
      // failure drives a client reconnect + full-refetch loop.
      const headers = { ...proxyRes.headers };
      delete headers["transfer-encoding"];
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", () => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end("Gateway proxy error");
      }
    });

    req.pipe(proxyReq);
  };
}
