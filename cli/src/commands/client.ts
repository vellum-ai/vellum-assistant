import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import {
  findAssistantByName,
  formatAssistantLookupError,
  getActiveAssistant,
  lookupAssistantByIdentifier,
  resolveAssistant,
  saveAssistantEntry,
  type AssistantEntry,
} from "../lib/assistant-config";
import {
  DAEMON_INTERNAL_ASSISTANT_ID,
  GATEWAY_PORT,
  type Species,
} from "../lib/constants";
import { loadGuardianToken, refreshGuardianToken } from "../lib/guardian-token";
import { getLocalLanIPv4 } from "../lib/local";
import {
  CLI_INTERFACE_ID,
  WEB_INTERFACE_ID,
  getClientRegistrationHeaders,
} from "../lib/client-identity";
import {
  getLockfileData,
  upsertLockfileAssistant,
  replacePlatformAssistants,
  runHatch,
  runRetire,
  getGuardianAccessToken,
  parseGatewayUrl,
  resolveGatewayProxyTarget,
  readAllowedGatewayPorts,
  isLoopbackAddr,
  resolveDevCliInvocation,
  resolveLockfilePaths,
  resolveConfigDir,
  type CliInvocation,
} from "@vellumai/local-mode";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import {
  fetchOrganizationId,
  fetchPlatformAssistants,
  getPlatformUrl,
  getWebUrl,
  readPlatformToken,
} from "../lib/platform-client";
import { tuiLog } from "../lib/tui-log";

const SUPPORTED_INTERFACES = ["cli", "web"] as const;
type SupportedInterface = (typeof SUPPORTED_INTERFACES)[number];

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

const FALLBACK_RUNTIME_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

interface ParsedArgs {
  runtimeUrl: string;
  assistantId: string;
  assistantName?: string;
  species: Species;
  /** "vellum" for platform-hosted assistants, undefined for local. */
  cloud?: string;
  /** Platform session token (X-Session-Token), set when cloud === "vellum". */
  platformToken?: string;
  /** Guardian JWT (Authorization: Bearer), set for local assistants. */
  bearerToken?: string;
  /** Interface identifier sent as X-Vellum-Interface-Id on all requests. */
  interfaceId: SupportedInterface;
  /** Run the web interface through a local nginx edge instead of the built-in web server. */
  nginx: boolean;
}

function readAssistantName(entry: AssistantEntry | null): string | undefined {
  const rawName = entry?.name ?? entry?.assistantName;
  return typeof rawName === "string" && rawName.trim()
    ? rawName.trim()
    : undefined;
}

// Exported for unit testing the arg/auth resolution without launching the TUI.
export function parseArgs(): ParsedArgs {
  const args = process.argv.slice(3);

  const positionalName = parseAssistantTargetArg(args, [
    "--url",
    "-u",
    "--assistant-id",
    "-a",
    "--interface",
    "-i",
    "--token",
    "-t",
  ]);
  const flagArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (
      (arg === "--url" ||
        arg === "-u" ||
        arg === "--assistant-id" ||
        arg === "-a" ||
        arg === "--interface" ||
        arg === "-i" ||
        arg === "--token" ||
        arg === "-t") &&
      args[i + 1]
    ) {
      flagArgs.push(arg, args[++i]);
    }
  }

  let entry: AssistantEntry | null = null;
  if (positionalName) {
    const result = lookupAssistantByIdentifier(positionalName);
    if (result.status !== "found") {
      console.error(formatAssistantLookupError(positionalName, result));
      process.exit(1);
    }
    entry = result.entry;
  } else {
    const hasExplicitUrl =
      flagArgs.includes("--url") || flagArgs.includes("-u");
    const active = getActiveAssistant();
    if (active) {
      const result = lookupAssistantByIdentifier(active);
      if (result.status === "found") {
        entry = result.entry;
      }
      if (!entry && !hasExplicitUrl) {
        console.error(
          `Active assistant '${active}' not found in lockfile. Set an active assistant with 'vellum use <name-or-id>'.`,
        );
        process.exit(1);
      }
    }
    if (!entry && hasExplicitUrl) {
      // URL provided but active assistant missing or unset — resolve for remaining defaults
      entry = resolveAssistant();
    } else if (!entry) {
      console.error(
        "No active assistant set. Set one with 'vellum use <name-or-id>' or specify one: 'vellum client <name-or-id>'.",
      );
      process.exit(1);
    }
  }

  let runtimeUrl = entry?.localUrl || entry?.runtimeUrl || FALLBACK_RUNTIME_URL;
  let assistantId = entry?.assistantId || DAEMON_INTERNAL_ASSISTANT_ID;
  let assistantName = readAssistantName(entry);
  const cloud = entry?.cloud;
  const species: Species = (entry?.species as Species) ?? "vellum";

  // Ephemeral auth: a handed-over token (e.g. from `vellum pair`) used for this
  // session only. Resolve it BEFORE the credential lookup below so an ephemeral
  // session never reads (or writes) the local token store.
  let bearerTokenOverride: string | undefined;
  for (let i = 0; i < flagArgs.length; i++) {
    if (
      (flagArgs[i] === "--token" || flagArgs[i] === "-t") &&
      flagArgs[i + 1]
    ) {
      bearerTokenOverride = flagArgs[i + 1];
    }
  }

  // Platform-hosted assistants (cloud "vellum") use a session token; every
  // other topology — local, docker, and "paired" (a remote assistant paired
  // from another machine) — uses a bearer guardian JWT. Both are skipped
  // entirely when --token supplies the credential, so no saved creds are read.
  const platformToken = bearerTokenOverride
    ? undefined
    : cloud === "vellum"
      ? (readPlatformToken() ?? undefined)
      : undefined;
  const bearerToken = bearerTokenOverride
    ? bearerTokenOverride
    : cloud === "vellum"
      ? undefined
      : (loadGuardianToken(entry?.assistantId ?? "")?.accessToken ?? undefined);

  let interfaceId: SupportedInterface = CLI_INTERFACE_ID;
  let nginx = false;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if ((flag === "--url" || flag === "-u") && args[i + 1]) {
      runtimeUrl = args[++i] ?? runtimeUrl;
    } else if ((flag === "--assistant-id" || flag === "-a") && args[i + 1]) {
      assistantId = args[++i] ?? assistantId;
      assistantName = undefined;
    } else if ((flag === "--interface" || flag === "-i") && args[i + 1]) {
      const value = args[++i] ?? "";
      if (!(SUPPORTED_INTERFACES as readonly string[]).includes(value)) {
        console.error(
          `Unknown interface '${value}'. Supported: ${SUPPORTED_INTERFACES.join(", ")}.`,
        );
        process.exit(1);
      }
      interfaceId = value as SupportedInterface;
    } else if (flag === "--nginx") {
      nginx = true;
    }
  }

  return {
    runtimeUrl: maybeSwapToLocalhost(runtimeUrl.replace(/\/+$/, "")),
    assistantId,
    assistantName,
    species,
    cloud,
    platformToken,
    bearerToken,
    interfaceId,
    nginx,
  };
}

/**
 * If the hostname in `url` matches this machine's local DNS name, LAN IP, or
 * raw hostname, replace it with 127.0.0.1 so the client avoids mDNS round-trips
 * when talking to an assistant running on the same machine.
 */
function maybeSwapToLocalhost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const urlHost = parsed.hostname.toLowerCase();

  const localNames: string[] = [];

  const host = hostname();
  if (host) {
    localNames.push(host.toLowerCase());
    // Also consider the bare name without .local suffix
    if (host.toLowerCase().endsWith(".local")) {
      localNames.push(host.toLowerCase().slice(0, -".local".length));
    }
  }

  const lanIp = getLocalLanIPv4();
  if (lanIp) {
    localNames.push(lanIp);
  }

  if (localNames.includes(urlHost)) {
    parsed.hostname = "127.0.0.1";
    return parsed.toString().replace(/\/+$/, "");
  }

  return url;
}

function printUsage(): void {
  console.log(`${ANSI.bold}vellum client${ANSI.reset} - Connect to a hatched assistant

${ANSI.bold}USAGE:${ANSI.reset}
    vellum client [name-or-id] [options]

${ANSI.bold}ARGUMENTS:${ANSI.reset}
    [name-or-id]               Assistant display name or ID (default: active)

${ANSI.bold}OPTIONS:${ANSI.reset}
    -u, --url <url>            Runtime URL
    -t, --token <jwt>          Bearer token to use for this session (e.g. from
                              'vellum pair'). Overrides the stored token and is
                              not persisted.
    -a, --assistant-id <id>    Assistant ID
    -i, --interface <id>       Interface identifier: cli (default) or web
        --nginx                With --interface web, serve the SPA through nginx on 127.0.0.1:3000
    -h, --help                 Show this help message

${ANSI.bold}DEFAULTS:${ANSI.reset}
    Reads from ~/.vellum.lock.json (created by vellum hatch).
    Override with flags above.

${ANSI.bold}EXAMPLES:${ANSI.reset}
    vellum client
    vellum client vellum-assistant-foo
    vellum client --interface web --nginx
    vellum client --url http://34.56.78.90:${GATEWAY_PORT}
    vellum client vellum-assistant-foo --url http://localhost:${GATEWAY_PORT}

    # Ephemeral: connect to another machine's assistant with a paired token
    # (no lockfile entry, nothing persisted):
    vellum client --url http://10.0.0.196:${GATEWAY_PORT} --token <jwt>
`);
}

async function maybeHydratePlatformAssistantName(
  assistantId: string,
  assistantName: string | undefined,
  cloud: string | undefined,
  platformToken: string | undefined,
): Promise<string | undefined> {
  if (cloud !== "vellum" || assistantName || !platformToken) {
    return assistantName;
  }

  try {
    const matchedAssistant = (
      await fetchPlatformAssistants(platformToken)
    ).find((assistant) => assistant.id === assistantId);
    const hydratedName = matchedAssistant?.name.trim();
    if (!hydratedName) {
      return assistantName;
    }

    const entry = findAssistantByName(assistantId);
    if (entry && entry.name !== hydratedName) {
      saveAssistantEntry({
        ...entry,
        name: hydratedName,
      });
    }

    return hydratedName;
  } catch {
    return assistantName;
  }
}

const SPA_BASE = "/assistant/";
const DEFAULT_NGINX_PORT = 3000;
const NGINX_CACHE_NO_STORE = "no-store";
const NGINX_CACHE_HASHED_ASSETS = "public, max-age=31536000, immutable";
const NGINX_CACHE_PUBLIC_FILES = "public, max-age=3600";

/**
 * Locate the pre-built @vellumai/web dist directory.
 *
 * Resolution order:
 *   1. npm-installed package — require.resolve('@vellumai/web/package.json')
 *   2. Source checkout — walk up from cli/ to find apps/web/dist/
 */
function findWebDistDir(): string | null {
  try {
    const pkgPath = require.resolve("@vellumai/web/package.json");
    const distDir = path.join(path.dirname(pkgPath), "dist");
    if (existsSync(path.join(distDir, "index.html"))) {
      return distDir;
    }
  } catch {
    // Package not installed; try source checkout.
  }

  let dir = import.meta.dir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, "apps", "web", "dist", "index.html");
    if (existsSync(candidate)) {
      return path.dirname(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parsePortEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

function nginxQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeGatewayUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid gateway URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Gateway URL must use http or https, got ${parsed.protocol}`,
    );
  }

  // The self-hosted nginx edge proxies route namespaces to the gateway root.
  // Runtime URLs are expected to be gateway origins, so discard path/query/hash
  // here rather than creating surprising nginx proxy_pass URI rewriting.
  return parsed.origin;
}

function buildNginxConfig(opts: {
  distDir: string;
  gatewayUrl: string;
  listenPort: number;
}): string {
  const distDir = opts.distDir.replace(/\/+$/, "");
  const distRoot = nginxQuote(distDir);
  const gateway = normalizeGatewayUrl(opts.gatewayUrl);

  return `
worker_processes 1;
error_log stderr;
pid nginx.pid;

events {}

http {
  access_log off;
  default_type application/octet-stream;

  types {
    text/html html htm;
    text/css css;
    application/javascript js mjs;
    application/json json;
    application/wasm wasm;
    image/svg+xml svg svgz;
    image/png png;
    image/jpeg jpg jpeg;
    image/gif gif;
    image/x-icon ico;
    font/woff woff;
    font/woff2 woff2;
    font/ttf ttf;
    text/plain txt;
  }

  map $http_upgrade $connection_upgrade {
    default upgrade;
    "" close;
  }

  server {
    listen 127.0.0.1:${opts.listenPort};
    server_name localhost 127.0.0.1;
    client_max_body_size 512m;
    root ${distRoot};

    location = / {
      return 302 /assistant/;
    }

    location = /assistant {
      return 301 /assistant/;
    }

    location = /healthz {
      proxy_pass ${gateway};
      proxy_http_version 1.1;
      proxy_set_header Host $proxy_host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Host $host;
      proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /v1/ {
      proxy_pass ${gateway};
      proxy_http_version 1.1;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_read_timeout 1h;
      proxy_set_header Host $proxy_host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Host $host;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
    }

    location = /account {
      add_header Cache-Control "${NGINX_CACHE_NO_STORE}" always;
      try_files /index.html =404;
    }

    location /account/ {
      add_header Cache-Control "${NGINX_CACHE_NO_STORE}" always;
      try_files /index.html =404;
    }

    location = /logout {
      add_header Cache-Control "${NGINX_CACHE_NO_STORE}" always;
      try_files /index.html =404;
    }

    location = /assistant/ {
      add_header Cache-Control "${NGINX_CACHE_NO_STORE}" always;
      try_files /index.html =404;
    }

    location = /assistant/index.html {
      add_header Cache-Control "${NGINX_CACHE_NO_STORE}" always;
      try_files /index.html =404;
    }

    location ^~ /assistant/assets/ {
      rewrite ^/assistant/(.*)$ /$1 break;
      add_header Cache-Control "${NGINX_CACHE_HASHED_ASSETS}" always;
      try_files $uri =404;
    }

    location ^~ /assistant/ {
      rewrite ^/assistant/?(.*)$ /$1 break;
      add_header Cache-Control "${NGINX_CACHE_PUBLIC_FILES}" always;
      try_files $uri $uri/ @assistant_spa;
    }

    location @assistant_spa {
      add_header Cache-Control "${NGINX_CACHE_NO_STORE}" always;
      try_files /index.html =404;
    }

    location / {
      return 404;
    }
  }
}
`;
}

async function runNginxWebInterface(runtimeUrl: string): Promise<void> {
  const distDir = findWebDistDir();
  if (!distDir) {
    console.error(
      `${ANSI.bold}--interface web --nginx${ANSI.reset}: unable to locate ` +
        `built @vellumai/web assets.\n\n` +
        `  source checkout: cd apps/web && VITE_PLATFORM_MODE=false bun run build\n` +
        `  npm/bunx install: install a package that includes @vellumai/web/dist`,
    );
    process.exit(1);
  }

  const listenPort = parsePortEnv("VELLUM_WEB_NGINX_PORT", DEFAULT_NGINX_PORT);
  const nginxBin = process.env.NGINX_BIN || "nginx";

  const prefix = mkdtempSync(path.join(tmpdir(), "vellum-web-nginx-"));
  const confPath = path.join(prefix, "nginx.conf");
  writeFileSync(
    confPath,
    buildNginxConfig({ distDir, gatewayUrl: runtimeUrl, listenPort }),
  );

  const child = spawn(
    nginxBin,
    ["-p", prefix, "-c", confPath, "-g", "daemon off;"],
    { stdio: "inherit" },
  );

  let childStarted = false;

  const shutdown = (): void => {
    if (childStarted && child.exitCode === null) {
      child.kill();
    }
    process.exit(0);
  };

  child.on("spawn", () => {
    childStarted = true;
    console.log(
      `Vellum nginx web interface: http://127.0.0.1:${listenPort}${SPA_BASE}`,
    );
    console.log(`Gateway upstream: ${normalizeGatewayUrl(runtimeUrl)}`);
  });

  child.on("error", (err) => {
    console.error(
      `${ANSI.bold}--interface web --nginx${ANSI.reset}: failed to start ${nginxBin}: ${err.message}`,
    );
    process.exit(1);
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`nginx exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Locate the apps/web source directory for running the Vite dev server.
 * Only works from a source checkout (not npm-installed).
 */
function findWebSourceDir(): string | null {
  let dir = import.meta.dir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, "apps", "web", "vite.config.ts");
    if (existsSync(candidate)) {
      return path.dirname(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const LOCKFILE_PATTERN = /^(?:\/assistant)?\/__local\/lockfile$/;
const HATCH_PATTERN = /^(?:\/assistant)?\/__local\/hatch$/;
const RETIRE_PATTERN = /^(?:\/assistant)?\/__local\/retire$/;
const GUARDIAN_TOKEN_PATTERN =
  /^(?:\/assistant)?\/__local\/guardian-token\/([^/]+)$/;

function getEnvRecord(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

const _localEnv = getEnvRecord();
const _lockfilePaths = resolveLockfilePaths(_localEnv);
const _configDir = resolveConfigDir(_localEnv);
const _baseDir = getBaseDir();

async function handleLocalEndpoints(
  req: Request,
  url: URL,
  server: { requestIP(req: Request): { address: string } | null },
): Promise<Response | null> {
  const { pathname } = url;
  const lockfilePaths = _lockfilePaths;
  const configDir = _configDir;

  // Check if this is a __local or __gateway route before enforcing loopback.
  const isLocalRoute =
    LOCKFILE_PATTERN.test(pathname) ||
    HATCH_PATTERN.test(pathname) ||
    RETIRE_PATTERN.test(pathname) ||
    GUARDIAN_TOKEN_PATTERN.test(pathname) ||
    parseGatewayUrl(pathname).match;

  if (!isLocalRoute) return null;

  // All __local and __gateway endpoints are restricted to loopback clients.
  const peer = server.requestIP(req)?.address ?? "";
  if (!isLoopbackAddr(peer)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  // Lockfile
  if (LOCKFILE_PATTERN.test(pathname)) {
    if (req.method === "GET") {
      const result = getLockfileData(lockfilePaths);
      if (result.ok) {
        return Response.json(result.data);
      }
      return new Response(null, { status: result.status });
    }
    if (req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json(
          { ok: false, error: "Invalid JSON body" },
          { status: 400 },
        );
      }
      let result;
      if (body.syncPlatform && Array.isArray(body.platformAssistants)) {
        result = replacePlatformAssistants(
          lockfilePaths,
          body.platformAssistants as Array<Record<string, unknown>>,
        );
      } else {
        result = upsertLockfileAssistant(
          lockfilePaths,
          body.assistant as Record<string, unknown>,
          body.activeAssistant as string | undefined,
        );
      }
      return Response.json(result, { status: result.ok ? 200 : result.status });
    }
    return new Response(null, { status: 405 });
  }

  // Hatch
  if (HATCH_PATTERN.test(pathname)) {
    if (req.method !== "POST") return new Response(null, { status: 405 });

    let species = "vellum";
    let remote: string | undefined;
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      try {
        const body = (await req.json()) as {
          species?: string;
          remote?: string;
        };
        if (body.species) species = body.species;
        if (body.remote) remote = body.remote;
      } catch {
        return Response.json(
          { ok: false, error: "Invalid JSON body" },
          { status: 400 },
        );
      }
    }

    let invocation: CliInvocation;
    try {
      invocation = resolveDevCliInvocation(_baseDir);
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }

    const result = await runHatch(
      invocation,
      species,
      remote ? { remote } : undefined,
    );
    if (result.ok) {
      return Response.json({ ok: true, assistantId: result.assistantId });
    }
    return Response.json(
      { ok: false, error: result.error },
      { status: result.status },
    );
  }

  // Retire
  if (RETIRE_PATTERN.test(pathname)) {
    if (req.method !== "POST") return new Response(null, { status: 405 });

    let assistantId: string | undefined;
    try {
      const body = (await req.json()) as { assistantId?: string };
      assistantId = body.assistantId;
    } catch {
      return Response.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    if (!assistantId) {
      return Response.json(
        { ok: false, error: "Missing assistantId" },
        { status: 400 },
      );
    }

    let invocation: CliInvocation;
    try {
      invocation = resolveDevCliInvocation(_baseDir);
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }

    const result = await runRetire(invocation, assistantId);
    if (result.ok) {
      return Response.json({ ok: true });
    }
    return Response.json(
      { ok: false, error: result.error },
      { status: result.status },
    );
  }

  // Guardian token
  const guardianMatch = pathname.match(GUARDIAN_TOKEN_PATTERN);
  if (guardianMatch) {
    if (req.method !== "GET") return new Response(null, { status: 405 });

    const assistantId = decodeURIComponent(guardianMatch[1]!);

    let invocation: CliInvocation;
    try {
      invocation = resolveDevCliInvocation(_baseDir);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }

    const result = await getGuardianAccessToken(
      assistantId,
      configDir,
      invocation,
      true,
      _localEnv,
    );
    if (result.ok) {
      return Response.json({ accessToken: result.accessToken });
    }
    return Response.json({ error: result.error }, { status: result.status });
  }

  // Gateway proxy — same allowlist decision the web (Vite middleware) and
  // Electron (`app://` handler) hosts use, so all three can't drift.
  const gatewayDecision = resolveGatewayProxyTarget(pathname, () =>
    readAllowedGatewayPorts(lockfilePaths),
  );
  if (gatewayDecision.kind === "invalid-port") {
    return new Response("Port must be between 1024 and 65535", { status: 400 });
  }
  if (gatewayDecision.kind === "forbidden-port") {
    return new Response("Gateway port is not active in lockfile", {
      status: 403,
    });
  }
  if (gatewayDecision.kind === "forward") {
    const { target: gatewayTarget } = gatewayDecision;
    const targetUrl = `http://127.0.0.1:${gatewayTarget.port}${gatewayTarget.path}${url.search}`;
    const headers = new Headers(req.headers);
    headers.set("host", `127.0.0.1:${gatewayTarget.port}`);

    try {
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const proxyRes = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: hasBody ? req.body : undefined,
        redirect: "manual",
      });
      const resHeaders = new Headers(proxyRes.headers);
      resHeaders.delete("transfer-encoding");
      return new Response(proxyRes.body, {
        status: proxyRes.status,
        statusText: proxyRes.statusText,
        headers: resHeaders,
      });
    } catch {
      return new Response("Gateway proxy error", { status: 502 });
    }
  }

  return null;
}

function getBaseDir(): string {
  let dir = import.meta.dir;
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(path.join(dir, "cli", "src", "index.ts"))) {
      return dir;
    }
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(import.meta.dir, "..", "..", "..");
}

async function runWebInterface(): Promise<void> {
  // Prefer Vite dev server in source checkouts for full local-mode support
  // (HMR, __local endpoints, gateway proxy).
  const webSourceDir = findWebSourceDir();
  if (webSourceDir) {
    return runViteDevServer(webSourceDir);
  }

  const distDir = findWebDistDir();
  if (!distDir) {
    console.error(
      `${ANSI.bold}--interface web${ANSI.reset}: unable to locate ` +
        `@vellumai/web assets.\n\n` +
        `  npm/bunx install:   npm install @vellumai/web\n` +
        `  source checkout:    cd apps/web && VITE_PLATFORM_MODE=false bun run build`,
    );
    process.exit(1);
  }

  const rawIndexHtml = await Bun.file(path.join(distDir, "index.html")).text();
  const platformUrl = getPlatformUrl();
  const webUrl = getWebUrl();
  const configJson = JSON.stringify({ webUrl, platformUrl });
  const indexHtml = rawIndexHtml.replace(
    "</head>",
    `<script>window.__VELLUM_CONFIG__=${configJson}</script></head>`,
  );

  const server = Bun.serve({
    port: 3000,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname === "/" || pathname === "/assistant") {
        return Response.redirect(SPA_BASE, 302);
      }

      // Loopback auth: the platform redirects here after login with
      // ?state=...&session_token=... — forward into the SPA.
      if (pathname === "/callback") {
        return Response.redirect(
          `/account/platform-callback${url.search}`,
          302,
        );
      }

      // Expose environment config to the SPA.
      if (pathname === "/assistant/__config" || pathname === "/__config") {
        return new Response(configJson, {
          headers: { "Content-Type": "application/json" },
        });
      }

      // __local endpoints for local-mode (lockfile, hatch, retire, guardian-token, gateway-proxy).
      const localResponse = await handleLocalEndpoints(req, url, server);
      if (localResponse) return localResponse;

      // Reverse-proxy platform API requests.
      if (
        pathname.startsWith("/v1/") ||
        pathname.startsWith("/_allauth/") ||
        pathname.startsWith("/accounts/")
      ) {
        const target = new URL(pathname + url.search, platformUrl);
        const headers = new Headers(req.headers);
        headers.set("Host", new URL(platformUrl).host);
        headers.delete("Origin");
        headers.delete("Referer");

        // Forward the session token — the loopback flow stores it in
        // the browser cookie jar for localhost, but the platform backend
        // expects it on its own domain. Set both the Cookie (for Django
        // session middleware / allauth) and X-Session-Token (for DRF
        // views that accept header-based auth).
        const sessionToken = /sessionid=([^;]+)/.exec(
          req.headers.get("Cookie") ?? "",
        )?.[1];
        if (sessionToken) {
          headers.set(
            "Cookie",
            `sessionid=${sessionToken}; __Secure-sessionid=${sessionToken}`,
          );
          headers.set("X-Session-Token", sessionToken);
        }

        try {
          const hasBody = req.method !== "GET" && req.method !== "HEAD";
          const body = hasBody ? await req.arrayBuffer() : undefined;
          const proxyRes = await fetch(target.toString(), {
            method: req.method,
            headers,
            body,
            redirect: "manual",
          });
          const resHeaders = new Headers(proxyRes.headers);
          resHeaders.delete("transfer-encoding");
          return new Response(proxyRes.body, {
            status: proxyRes.status,
            statusText: proxyRes.statusText,
            headers: resHeaders,
          });
        } catch (err) {
          return new Response(
            JSON.stringify({ error: `Platform proxy error: ${err}` }),
            { status: 502, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      if (pathname.startsWith(SPA_BASE)) {
        const relPath = pathname.slice(SPA_BASE.length);
        if (relPath) {
          const filePath = path.join(distDir, relPath);
          const file = Bun.file(filePath);
          if (await file.exists()) {
            return new Response(file);
          }
        }
        return new Response(indexHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // SPA fallback for /account/* routes (login, callback, etc.)
      if (pathname.startsWith("/account/")) {
        return new Response(indexHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(
    `Vellum web interface: http://${server.hostname}:${server.port}${SPA_BASE}`,
  );

  const shutdown = (): void => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

async function runViteDevServer(webSourceDir: string): Promise<void> {
  const platformUrl = getPlatformUrl();

  const child = spawn("bun", ["run", "dev"], {
    cwd: webSourceDir,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_PLATFORM_MODE: "false",
      API_PROXY_TARGET: platformUrl,
      VELLUM_WEB_URL: getWebUrl(),
      VELLUM_PLATFORM_URL: platformUrl,
      PORT: "3000",
    },
  });

  const shutdown = (): void => {
    child.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((_, reject) => {
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Vite dev server exited with code ${code}`));
      }
    });
  });
}

/**
 * Return a possibly-refreshed bearer token for the TUI's startup auth.
 *
 * Only a STORED guardian token is refreshable: platform session auth
 * (`cloud === "vellum"`) and ephemeral `--token` overrides (whose token won't
 * match the store) are left untouched, as is a token that's still fresh. When
 * the stored token has passed its `refreshAfter` (or expiry) and a refresh
 * token is available, refresh once via the concurrency-safe refreshGuardianToken
 * and use the rotated access token. Falls back to the existing token if refresh
 * isn't possible/fails — the session still starts (same as before).
 */
export async function resolveFreshBearerToken(
  runtimeUrl: string,
  assistantId: string,
  bearerToken: string | undefined,
  cloud: string | undefined,
): Promise<string | undefined> {
  if (cloud === "vellum" || !bearerToken || !assistantId) return bearerToken;

  const stored = loadGuardianToken(assistantId);
  // Refresh only the stored token (an ephemeral --token won't match), and only
  // when a refresh credential is present.
  if (!stored || stored.accessToken !== bearerToken || !stored.refreshToken) {
    return bearerToken;
  }

  // new Date() handles both ISO strings and epoch-ms numbers; Date.parse of an
  // epoch-ms string would be NaN.
  const renewAtRaw = stored.refreshAfter || stored.accessTokenExpiresAt;
  const renewAt = new Date(renewAtRaw).getTime();
  if (!Number.isFinite(renewAt) || renewAt > Date.now()) return bearerToken;

  const refreshed = await refreshGuardianToken(runtimeUrl, assistantId);
  return refreshed?.accessToken ?? bearerToken;
}

export async function client(): Promise<void> {
  const {
    runtimeUrl,
    assistantId,
    assistantName: parsedAssistantName,
    species,
    cloud,
    platformToken,
    bearerToken,
    interfaceId,
    nginx,
  } = parseArgs();

  if (interfaceId === WEB_INTERFACE_ID) {
    if (nginx) {
      await runNginxWebInterface(runtimeUrl);
      return;
    }
    await runWebInterface();
    return;
  }

  tuiLog.init();
  tuiLog.info("session start", {
    runtimeUrl,
    assistantId,
    species,
    cloud,
    interfaceId,
  });

  const assistantName = await maybeHydratePlatformAssistantName(
    assistantId,
    parsedAssistantName,
    cloud,
    platformToken,
  );

  // Build pre-constructed request headers merged from auth + client registration.
  // Spreading into every fetch site ensures consistency across REST and SSE endpoints.
  let auth: Record<string, string> | undefined;
  if (cloud === "vellum" && platformToken) {
    const orgId = await fetchOrganizationId(platformToken).catch((err) => {
      tuiLog.warn("failed to fetch organization id", { err: String(err) });
      return undefined;
    });
    auth = {
      "X-Session-Token": platformToken,
      ...(orgId ? { "Vellum-Organization-Id": orgId } : {}),
      ...getClientRegistrationHeaders(interfaceId),
    };
  } else {
    // Proactively refresh a stale STORED guardian token before opening the TUI,
    // so launching after the access token expired renews transparently rather
    // than erroring. (Mid-session expiry — the token dying while the TUI is
    // already open — is a separate follow-up, since the TUI threads a static
    // auth object through React.)
    const token = await resolveFreshBearerToken(
      runtimeUrl,
      assistantId,
      bearerToken,
      cloud,
    );
    auth = {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...getClientRegistrationHeaders(interfaceId),
    };
  }

  const { renderChatApp } = await import("../components/DefaultMainScreen");

  process.stdout.write("\x1b[2J\x1b[H");

  const app = renderChatApp(
    runtimeUrl,
    assistantId,
    species,
    () => {
      tuiLog.info("session end (user disconnect)");
      tuiLog.close();
      app.unmount();
      process.stdout.write("\x1b[2J\x1b[H");
      console.log(`${ANSI.dim}Disconnected.${ANSI.reset}`);
      process.exit(0);
    },
    { auth, assistantName },
  );
}
