import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Plugin, Connect } from "vite";

const PRODUCTION_ENVIRONMENT_NAME = "production";

/**
 * Sensitive lockfile fields that must never be served to the browser.
 */
const SENSITIVE_FIELDS = [
  "signingKey",
  "bearerToken",
  "guardianBootstrapSecret",
] as const;

/**
 * Resolve the lockfile path on disk using XDG conventions.
 *
 * Mirrors `cli/src/lib/environments/paths.ts` logic:
 * - Production: `~/.vellum.lock.json`
 * - Non-production: `$XDG_CONFIG_HOME/vellum-{env}/lockfile.json`
 * - `VELLUM_LOCKFILE_DIR` overrides the directory in both cases.
 */
function resolveLockfilePaths(env: Record<string, string>): string[] {
  const vellumEnv = env.VELLUM_ENVIRONMENT || PRODUCTION_ENVIRONMENT_NAME;
  const lockfileDir = env.VELLUM_LOCKFILE_DIR;

  if (vellumEnv === PRODUCTION_ENVIRONMENT_NAME) {
    const dir = lockfileDir ?? os.homedir();
    return [
      path.join(dir, ".vellum.lock.json"),
      path.join(dir, ".vellum.lockfile.json"),
    ];
  }

  const xdgConfigHome =
    env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const dir = lockfileDir ?? path.join(xdgConfigHome, `vellum-${vellumEnv}`);
  return [path.join(dir, "lockfile.json")];
}

/**
 * Strip sensitive fields from each assistant entry in the lockfile data.
 */
function stripSensitiveFields(data: Record<string, unknown>): void {
  const assistants = data.assistants;
  if (!Array.isArray(assistants)) return;
  for (const assistant of assistants) {
    if (assistant && typeof assistant === "object") {
      const entry = assistant as Record<string, unknown>;
      for (const field of SENSITIVE_FIELDS) {
        delete entry[field];
      }
      const resources = entry.resources;
      if (resources && typeof resources === "object") {
        for (const field of SENSITIVE_FIELDS) {
          delete (resources as Record<string, unknown>)[field];
        }
      }
    }
  }
}

/**
 * Vite plugin that serves lockfile endpoints and a dynamic gateway proxy
 * for local-mode development.
 */
export function localModePlugin(env: Record<string, string>): Plugin {
  const lockfilePaths = resolveLockfilePaths(env);

  return {
    name: "vellum-local-mode",
    configureServer(server) {
      server.middlewares.use(lockfileMiddleware(lockfilePaths));
      server.middlewares.use(gatewayProxyMiddleware());
    },
  };
}

/**
 * Connect middleware for the lockfile read endpoint.
 */
function lockfileMiddleware(
  lockfilePaths: string[],
): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.url !== "/assistant/__local/lockfile" && req.url !== "/__local/lockfile") return next();

    if (req.method === "GET") {
      handleGetLockfile(lockfilePaths, res);
    } else {
      res.statusCode = 405;
      res.end();
    }
  };
}

function handleGetLockfile(
  lockfilePaths: string[],
  res: http.ServerResponse,
): void {
  let raw: string | undefined;
  for (const candidate of lockfilePaths) {
    try {
      raw = fs.readFileSync(candidate, "utf-8");
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        res.statusCode = 500;
        res.end();
        return;
      }
    }
  }

  if (!raw) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ assistants: [], activeAssistant: null }));
    return;
  }

  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    stripSensitiveFields(data);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  } catch {
    res.statusCode = 500;
    res.end();
  }
}

const GATEWAY_PATTERN = /^(?:\/assistant)?\/__gateway\/(\d+)(\/.*)?$/;

/**
 * Connect middleware that proxies requests to local gateway ports.
 *
 * Matches `/__gateway/:port/*` and forwards to `http://127.0.0.1:{port}{rest}`.
 * Supports chunked transfer and SSE by piping without buffering.
 */
function gatewayProxyMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = req.url?.match(GATEWAY_PATTERN);
    if (!match) return next();

    const port = parseInt(match[1]!, 10);
    if (port < 1024 || port > 65535) {
      res.statusCode = 400;
      res.end("Port must be between 1024 and 65535");
      return;
    }

    const restPath = match[2] || "/";

    const proxyOptions: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: restPath,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    };

    const proxyReq = http.request(proxyOptions, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", () => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end("Gateway proxy error");
      }
    });

    // Pipe the incoming request body to the proxy request (supports POST, etc.)
    req.pipe(proxyReq);
  };
}
