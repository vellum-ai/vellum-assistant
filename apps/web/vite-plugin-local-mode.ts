import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Plugin, Connect } from "vite";

const PRODUCTION_ENVIRONMENT_NAME = "production";
const CLI_PACKAGE_NAME = "@vellumai/cli";

let _resolvedCliPath: string | undefined;

/**
 * Resolve the CLI entry point via two strategies:
 *
 * 1. **Source tree** — `<repoRoot>/cli/src/index.ts` exists (dev mode in monorepo).
 * 2. **Installed package** — `require.resolve("@vellumai/cli/package.json")` then
 *    derive the entry point from the resolved package directory.
 *
 * The result is cached for the lifetime of the Vite server process.
 */
function resolveCliPath(): string {
  if (_resolvedCliPath) return _resolvedCliPath;

  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const sourceTreePath = path.join(repoRoot, "cli", "src", "index.ts");
  if (fs.existsSync(sourceTreePath)) {
    _resolvedCliPath = sourceTreePath;
    return _resolvedCliPath;
  }

  const _require = createRequire(import.meta.url);
  try {
    const pkgPath = _require.resolve(`${CLI_PACKAGE_NAME}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { bin?: Record<string, string> };
    const binEntry = pkg.bin?.["vellum"];
    if (binEntry) {
      const entryPoint = path.resolve(path.dirname(pkgPath), binEntry);
      if (fs.existsSync(entryPoint)) {
        _resolvedCliPath = entryPoint;
        return _resolvedCliPath;
      }
    }
  } catch {
    // Not found in node_modules
  }

  throw new Error(
    `Vellum CLI not found. Looked for source tree at ${sourceTreePath} and npm package ${CLI_PACKAGE_NAME}.`,
  );
}

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
      server.middlewares.use(hatchMiddleware());
      server.middlewares.use(retireMiddleware());
      server.middlewares.use(guardianTokenMiddleware(env));
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
    } else if (req.method === "POST") {
      handlePostLockfile(lockfilePaths, req, res);
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

/**
 * Merge an assistant entry into the lockfile on disk.
 *
 * Transport: Vite dev middleware (fs read/write).
 * In Electron, replace with IPC call to main process: window.electronAPI.saveLockfileAssistant(entry). (LUM-1998)
 */
function handlePostLockfile(
  lockfilePaths: string[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
      return;
    }

    const assistant = body.assistant as Record<string, unknown> | undefined;
    const activeAssistant = body.activeAssistant as string | undefined;
    if (!assistant || typeof assistant.assistantId !== "string") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "Missing assistant.assistantId" }));
      return;
    }

    // Read existing lockfile
    let lockfile: Record<string, unknown> = { assistants: [], activeAssistant: null };
    const writePath = lockfilePaths[0]!;
    for (const candidate of lockfilePaths) {
      try {
        lockfile = JSON.parse(fs.readFileSync(candidate, "utf-8")) as Record<string, unknown>;
        break;
      } catch {
        // continue
      }
    }

    // Upsert the assistant entry
    const assistants = Array.isArray(lockfile.assistants) ? lockfile.assistants : [];
    const existingIdx = assistants.findIndex(
      (a: Record<string, unknown>) => a?.assistantId === assistant.assistantId,
    );
    if (existingIdx >= 0) {
      assistants[existingIdx] = { ...assistants[existingIdx], ...assistant };
    } else {
      assistants.push(assistant);
    }
    lockfile.assistants = assistants;
    if (activeAssistant !== undefined) {
      lockfile.activeAssistant = activeAssistant;
    }

    // Atomic write
    try {
      const dir = path.dirname(writePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${writePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(lockfile, null, 2));
      fs.renameSync(tmp, writePath);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: `Failed to write lockfile: ${err}` }));
      return;
    }

    const stripped = JSON.parse(JSON.stringify(lockfile)) as Record<string, unknown>;
    stripSensitiveFields(stripped);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, lockfile: stripped }));
  });
}

const HATCH_TIMEOUT_MS = 120_000;

/**
 * Connect middleware for the hatch endpoint.
 *
 * Transport: Vite dev middleware (child_process.spawn → CLI binary).
 * In Electron, replace with IPC call to main process: window.electronAPI.hatchAssistant(species). (LUM-1997)
 * The main process has direct access to the hatch-local module without spawning a subprocess.
 */
function hatchMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (
      req.url !== "/assistant/__local/hatch" &&
      req.url !== "/__local/hatch"
    ) {
      return next();
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let species = "vellum";
      if (chunks.length > 0) {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            species?: string;
          };
          if (body.species) {
            species = body.species;
          }
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          return;
        }
      }

      handleHatch(species, res);
    });
  };
}

function handleHatch(species: string, res: http.ServerResponse): void {
  let cliPath: string;
  try {
    cliPath = resolveCliPath();
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

  const child = spawn("bun", ["run", cliPath, "hatch", species], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let responded = false;

  const respond = (status: number, body: Record<string, unknown>) => {
    if (responded) return;
    responded = true;
    clearTimeout(timeout);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    respond(500, { ok: false, error: "Hatch timed out after 120 seconds" });
  }, HATCH_TIMEOUT_MS);

  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
  });

  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  child.on("close", (code) => {
    if (code === 0) {
      const match = stdout.match(/Hatching local assistant:\s+(.+)/);
      const assistantId = match?.[1]?.trim() ?? "";
      respond(200, { ok: true, assistantId });
    } else {
      respond(500, { ok: false, error: stderr || stdout });
    }
  });

  child.on("error", (err) => {
    respond(500, { ok: false, error: `Failed to spawn CLI: ${err.message}` });
  });
}

/**
 * Connect middleware for the retire endpoint.
 *
 * Transport: Vite dev middleware (child_process.spawn → CLI binary).
 * In Electron, replace with IPC call to main process: window.electronAPI.retireAssistant(assistantId). (LUM-2000)
 */
function retireMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (
      req.url !== "/assistant/__local/retire" &&
      req.url !== "/__local/retire"
    ) {
      return next();
    }

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

      handleRetire(assistantId, res);
    });
  };
}

const RETIRE_TIMEOUT_MS = 60_000;

function handleRetire(assistantId: string, res: http.ServerResponse): void {
  let cliPath: string;
  try {
    cliPath = resolveCliPath();
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

  const child = spawn("bun", ["run", cliPath, "retire", assistantId, "--yes"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let responded = false;

  const respond = (status: number, body: Record<string, unknown>) => {
    if (responded) return;
    responded = true;
    clearTimeout(timeout);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    respond(500, { ok: false, error: "Retire timed out after 60 seconds" });
  }, RETIRE_TIMEOUT_MS);

  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
  });

  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  child.on("close", (code) => {
    if (code === 0) {
      respond(200, { ok: true });
    } else {
      respond(500, { ok: false, error: stderr || stdout });
    }
  });

  child.on("error", (err) => {
    respond(500, { ok: false, error: `Failed to spawn CLI: ${err.message}` });
  });
}

// ---------------------------------------------------------------------------
// Guardian token middleware
// ---------------------------------------------------------------------------

function isLoopbackAddr(addr: string): boolean {
  const v4Mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const normalized = v4Mapped ? v4Mapped[1]! : addr;
  if (normalized.includes(".")) {
    return normalized.startsWith("127.");
  }
  return normalized === "::1";
}

const GUARDIAN_TOKEN_PATTERN =
  /^(?:\/assistant)?\/__local\/guardian-token\/([^/]+)$/;

const GUARDIAN_TOKEN_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Resolve the config directory matching `cli/src/lib/environments/paths.ts:getConfigDir`.
 */
function resolveConfigDir(env: Record<string, string>): string {
  const vellumEnv = env.VELLUM_ENVIRONMENT || PRODUCTION_ENVIRONMENT_NAME;
  const xdgConfigHome =
    env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  if (vellumEnv === PRODUCTION_ENVIRONMENT_NAME) {
    return path.join(xdgConfigHome, "vellum");
  }
  return path.join(xdgConfigHome, `vellum-${vellumEnv}`);
}

function resolveGuardianTokenPath(
  env: Record<string, string>,
  assistantId: string,
): string {
  return path.join(resolveConfigDir(env), "assistants", assistantId, "guardian-token.json");
}

interface GuardianTokenData {
  accessToken: string;
  accessTokenExpiresAt: string | number;
  refreshToken: string;
  refreshTokenExpiresAt: string | number;
}

function isAccessTokenExpired(data: GuardianTokenData): boolean {
  const expiresAt = new Date(data.accessTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return true;
  return Date.now() >= expiresAt - 60_000;
}

function isRefreshTokenExpired(data: GuardianTokenData): boolean {
  const expiresAt = new Date(data.refreshTokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return true;
  return Date.now() >= expiresAt;
}

/**
 * Connect middleware that serves guardian access tokens for local assistants.
 *
 * GET /assistant/__local/guardian-token/:assistantId
 *
 * Reads the guardian token from disk. If the access token is expired,
 * shells out to the CLI to refresh it, then re-reads from disk.
 */
function guardianTokenMiddleware(
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

    const peer = req.socket.remoteAddress ?? "";
    if (!isLoopbackAddr(peer)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    const assistantId = decodeURIComponent(match[1]!);
    const tokenPath = resolveGuardianTokenPath(env, assistantId);

    let raw: string;
    try {
      raw = fs.readFileSync(tokenPath, "utf-8");
    } catch {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Guardian token not found" }));
      return;
    }

    let data: GuardianTokenData;
    try {
      data = JSON.parse(raw) as GuardianTokenData;
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Malformed guardian token file" }));
      return;
    }

    if (!isAccessTokenExpired(data)) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ accessToken: data.accessToken }));
      return;
    }

    if (isRefreshTokenExpired(data)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Guardian token expired — re-run `vellum hatch` or `vellum wake`" }));
      return;
    }

    // Refresh via CLI in a child process
    let cliPath: string;
    try {
      cliPath = resolveCliPath();
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    const child = spawn(
      "bun",
      ["run", cliPath, "gateway", "token", "refresh", assistantId],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
    );

    let stdout = "";
    let responded = false;

    const respond = (status: number, body: Record<string, unknown>) => {
      if (responded) return;
      responded = true;
      clearTimeout(timeout);
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      respond(500, { error: "Guardian token refresh timed out" });
    }, GUARDIAN_TOKEN_REFRESH_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        const accessToken = stdout.trim();
        if (accessToken) {
          respond(200, { accessToken });
        } else {
          respond(500, { error: "CLI returned empty token" });
        }
      } else {
        respond(401, { error: "Failed to refresh guardian token" });
      }
    });

    child.on("error", (err) => {
      respond(500, { error: `Failed to spawn CLI: ${err.message}` });
    });
  };
}

// ---------------------------------------------------------------------------
// Gateway proxy middleware
// ---------------------------------------------------------------------------

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
