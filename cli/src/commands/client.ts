import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
import {
  loadGuardianToken,
  refreshGuardianToken,
  guardianTokenDueForRenewal,
} from "../lib/guardian-token";
import { normalizeRuntimeUrl, trustedRefreshUrl } from "../lib/runtime-url";
import {
  CLI_INTERFACE_ID,
  WEB_INTERFACE_ID,
  getClientRegistrationHeaders,
} from "../lib/client-identity";
import {
  getLockfileData,
  upsertLockfileAssistant,
  replacePlatformAssistants,
  isActiveAssistant,
  runHatch,
  runRetire,
  getGuardianAccessToken,
  parseGatewayUrl,
  resolveGatewayProxyTarget,
  readAllowedGatewayPorts,
  isLoopbackAddr,
  headerHostIsLoopback,
  originIsAllowed,
  resolveDevCliInvocation,
  resolveLockfilePaths,
  resolveConfigDir,
  type CliInvocation,
} from "@vellumai/local-mode";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { parseFeatureFlagArgs, readAmbientFlagEnvVars } from "../lib/flag-args";
import {
  fetchOrganizationId,
  fetchPlatformAssistants,
  getPlatformUrl,
  getWebUrl,
  readPlatformToken,
  savePlatformToken,
  clearPlatformToken,
} from "../lib/platform-client";
import { tuiLog } from "../lib/tui-log";
import { CALLBACK_PATH } from "../lib/workos-pkce";
import { createWebLoginFlow } from "../lib/web-login";
import { loopbackSafeFetch } from "../lib/loopback-fetch.js";
import { probePort } from "../lib/port-probe.js";
import { openBrowser } from "../lib/open-browser";

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
  /** VELLUM_FLAG_* env vars for the gateway (process.env propagation). */
  flagEnvVars: Record<string, string>;
  /** Parsed --flag overrides: kebab-case key -> typed value (for web injection). */
  parsedFlagOverrides: Record<string, boolean | string>;
  disablePlatform: boolean;
  /** Auto-open the web interface in the default browser (--interface web only). */
  openBrowser: boolean;
}

function readAssistantName(entry: AssistantEntry | null): string | undefined {
  const rawName = entry?.name ?? entry?.assistantName;
  return typeof rawName === "string" && rawName.trim()
    ? rawName.trim()
    : undefined;
}

// Exported for unit testing the arg/auth resolution without launching the TUI.
export function parseArgs(): ParsedArgs {
  const { envVars: cliFlagVars, remaining: argsWithoutFlags } =
    parseFeatureFlagArgs(process.argv.slice(3));
  const flagEnvVars = { ...readAmbientFlagEnvVars(), ...cliFlagVars };
  const disablePlatformAmbient =
    process.env.VELLUM_DISABLE_PLATFORM?.trim().toLowerCase();
  let disablePlatform =
    disablePlatformAmbient === "true" || disablePlatformAmbient === "1";
  const args = argsWithoutFlags;

  // Build parsedFlagOverrides from the extracted env vars:
  // VELLUM_FLAG_UPPER_SNAKE -> kebab-case key with typed value.
  const parsedFlagOverrides: Record<string, boolean | string> = {};
  for (const [envName, rawValue] of Object.entries(flagEnvVars)) {
    const snake = envName.replace(/^VELLUM_FLAG_/, "");
    const kebab = snake.toLowerCase().replace(/_/g, "-");
    const lower = rawValue.toLowerCase();
    if (["true", "1", "yes", "on"].includes(lower)) {
      parsedFlagOverrides[kebab] = true;
    } else if (["false", "0", "no", "off"].includes(lower)) {
      parsedFlagOverrides[kebab] = false;
    } else {
      parsedFlagOverrides[kebab] = rawValue;
    }
  }

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
  // Auto-open the web interface in the browser by default; --no-open opts out.
  let openBrowserPref = true;
  const flagArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--disable-platform") {
      disablePlatform = true;
    } else if (arg === "--no-open") {
      openBrowserPref = false;
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

  for (let i = 0; i < flagArgs.length; i++) {
    const flag = flagArgs[i];
    if ((flag === "--url" || flag === "-u") && flagArgs[i + 1]) {
      runtimeUrl = flagArgs[++i];
    } else if (
      (flag === "--assistant-id" || flag === "-a") &&
      flagArgs[i + 1]
    ) {
      assistantId = flagArgs[++i];
      assistantName = undefined;
    } else if ((flag === "--interface" || flag === "-i") && flagArgs[i + 1]) {
      const value = flagArgs[++i];
      if (!(SUPPORTED_INTERFACES as readonly string[]).includes(value)) {
        console.error(
          `Unknown interface '${value}'. Supported: ${SUPPORTED_INTERFACES.join(", ")}.`,
        );
        process.exit(1);
      }
      interfaceId = value as SupportedInterface;
    }
  }

  return {
    runtimeUrl: normalizeRuntimeUrl(runtimeUrl),
    assistantId,
    assistantName,
    species,
    cloud,
    platformToken,
    bearerToken,
    interfaceId,
    flagEnvVars,
    parsedFlagOverrides,
    disablePlatform,
    openBrowser: openBrowserPref,
  };
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
    --no-open                  Don't auto-open the browser (--interface web)
    --flag <key=value>         Feature flag override (repeatable, kebab-case key)
    --disable-platform         Suppress all outbound platform API calls
    -h, --help                 Show this help message

${ANSI.bold}DEFAULTS:${ANSI.reset}
    Reads from ~/.vellum.lock.json (created by vellum hatch).
    Override with flags above.

${ANSI.bold}EXAMPLES:${ANSI.reset}
    vellum client
    vellum client vellum-assistant-foo
    # Remote assistants must be reached over https (e.g. a tunnel) — the
    # guardian refresh token is only sent over https or a loopback address:
    vellum client --url https://your-tunnel.example
    vellum client vellum-assistant-foo --url http://localhost:${GATEWAY_PORT}

    # Ephemeral: connect to another machine's assistant with a paired token
    # (no lockfile entry, nothing persisted):
    vellum client --url https://your-tunnel.example --token <jwt>
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

/**
 * Locate the pre-built @vellumai/web dist directory.
 *
 * Resolution order:
 *   1. npm-installed package — require.resolve('@vellumai/web/package.json')
 *   2. Source checkout — walk up from cli/ to find clients/web/dist/
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
    const candidate = path.join(dir, "clients", "web", "dist", "index.html");
    if (existsSync(candidate)) {
      return path.dirname(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Locate the clients/web source directory for running the Vite dev server.
 * Only works from a source checkout (not npm-installed).
 */
function findWebSourceDir(): string | null {
  let dir = import.meta.dir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, "clients", "web", "vite.config.ts");
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
const LOGIN_START_PATTERN = /^(?:\/assistant)?\/__local\/login\/start$/;
const GUARDIAN_TOKEN_PATTERN =
  /^(?:\/assistant)?\/__local\/guardian-token\/([^/]+)$/;
const PLATFORM_SESSION_PATTERN =
  /^(?:\/assistant)?\/__local\/platform-session$/;

// The platform session token. Persisted via the same store the CLI uses (so
// `vellum client` restarts and CLI logins stay in sync), cached here to keep
// it off the per-request proxy path. Installed only by the PKCE flows
// (`vellum login` or the browser login below), never from a request body.
let platformSessionToken: string | null | undefined;
function currentPlatformToken(): string | null {
  if (platformSessionToken === undefined) {
    platformSessionToken = readPlatformToken();
  }
  return platformSessionToken;
}

// Browser PKCE login; installs the token into the same store `vellum login`
// writes, so restarts and CLI logins stay in sync.
const webLoginFlow = createWebLoginFlow({
  platformUrl: getPlatformUrl(),
  installToken: (token) => {
    savePlatformToken(token);
    platformSessionToken = token;
  },
});

// Whether to attach the platform credential to a proxied request. Only
// same-origin (SPA) traffic qualifies — a cross-site page must not be able to
// use the local proxy as a confused deputy for authenticated platform calls.
// Cross-origin fetches always send an Origin; `Sec-Fetch-Site` is a belt-and-
// braces check for browsers that send it.
function isSameOriginRequest(req: Request): boolean {
  if (!originIsAllowed(req.headers.get("origin") ?? undefined)) return false;
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

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
    PLATFORM_SESSION_PATTERN.test(pathname) ||
    LOGIN_START_PATTERN.test(pathname) ||
    parseGatewayUrl(pathname).match;

  if (!isLocalRoute) return null;

  // All __local and __gateway endpoints are restricted to loopback clients.
  const peer = server.requestIP(req)?.address ?? "";
  if (!isLoopbackAddr(peer)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  if (
    !headerHostIsLoopback(req.headers.get("host") ?? undefined) ||
    !originIsAllowed(req.headers.get("origin") ?? undefined)
  ) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  // Start the browser PKCE login: hold the verifier/state server-side and
  // hand the SPA the WorkOS authorize URL to navigate to.
  if (LOGIN_START_PATTERN.test(pathname)) {
    if (req.method !== "POST") {
      return new Response(null, { status: 405 });
    }
    return webLoginFlow.handleStart(url);
  }

  // Platform session: logout clears the token the proxy uses to authenticate
  // to the platform (installed by the PKCE flows — `vellum login` or the
  // browser login above). The browser never holds a session cookie.
  if (PLATFORM_SESSION_PATTERN.test(pathname)) {
    if (req.method === "DELETE") {
      clearPlatformToken();
      platformSessionToken = null;
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 405 });
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
          body.organizationId as string | undefined,
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

    if (!isActiveAssistant(lockfilePaths, assistantId)) {
      return Response.json(
        { ok: false, error: "Can only retire the active local assistant" },
        { status: 403 },
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
      const proxyRes = await loopbackSafeFetch(targetUrl, {
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

// Just the slice of a Bun server `fetchHandler` needs — matches the structural
// arg `handleLocalEndpoints` accepts, so Bun's `Server` is assignable to it.
type RequestPeerServer = {
  requestIP(req: Request): { address: string } | null;
};

const WEB_PORT_SCAN_LIMIT = 50;

type WebFetchHandler = (
  req: Request,
  server: RequestPeerServer,
) => Promise<Response>;

function isAddrInUse(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  return (
    e?.code === "EADDRINUSE" ||
    /EADDRINUSE|address already in use/i.test(e?.message ?? "")
  );
}

// Bind one loopback family; returns the server, or null when the port is in
// use. Server type is inferred from `Bun.serve` (avoids a generic mismatch).
function tryBindLoopback(
  port: number,
  hostname: string,
  fetchHandler: WebFetchHandler,
) {
  try {
    return Bun.serve({ port, hostname, fetch: fetchHandler });
  } catch (err) {
    if (isAddrInUse(err)) return null;
    throw err;
  }
}

/**
 * Bind the local web server on BOTH loopback families (`127.0.0.1` and `::1`)
 * so the app can be reached at `http://localhost:<port>` regardless of whether
 * the browser resolves `localhost` to IPv4 or IPv6 — matching the host the
 * platform hardcodes in its loopback login callback.
 *
 * IPv4 is mandatory. IPv6 is best-effort: if `::1` is already taken (e.g. the
 * local platform's `vel up` edge-proxy owns `[::]:<port>`), the port is
 * contested and we advance — otherwise `localhost` would resolve to that other
 * server. If IPv6 is simply unavailable on the host, we proceed IPv4-only.
 *
 * Never binds wildcard interfaces (`0.0.0.0`/`::`): the server exposes
 * `/__local/*` control endpoints, so it must stay loopback-only.
 */
function serveLoopback(preferredPort: number, fetchHandler: WebFetchHandler) {
  for (
    let port = preferredPort;
    port < preferredPort + WEB_PORT_SCAN_LIMIT;
    port++
  ) {
    const primary = tryBindLoopback(port, "127.0.0.1", fetchHandler);
    if (!primary) continue;

    try {
      const secondary = Bun.serve({
        port,
        hostname: "::1",
        fetch: fetchHandler,
      });
      return { port, servers: [primary, secondary] };
    } catch (err) {
      if (isAddrInUse(err)) {
        // `::1` is contested (e.g. `vel up`) — move ports so `localhost`
        // doesn't resolve to that other server.
        primary.stop(true);
        continue;
      }
      // IPv6 unavailable (e.g. EADDRNOTAVAIL) — IPv4-only is acceptable since
      // `localhost` then resolves to 127.0.0.1 anyway.
      return { port, servers: [primary] };
    }
  }
  throw new Error(
    `Could not bind a free loopback port in [${preferredPort}, ${preferredPort + WEB_PORT_SCAN_LIMIT - 1}]`,
  );
}

/**
 * Find the first port at/above `preferred` with nothing listening on either
 * loopback family. Used for the Vite dev server, which binds the port itself
 * (via the `PORT` env). Connect-probe based, so there's a small TOCTOU window
 * before Vite binds — acceptable for dev.
 */
async function findFreeDualLoopbackPort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + WEB_PORT_SCAN_LIMIT; port++) {
    const [busyV4, busyV6] = await Promise.all([
      probePort(port, "127.0.0.1"),
      probePort(port, "::1"),
    ]);
    if (!busyV4 && !busyV6) return port;
  }
  return preferred;
}

/**
 * Open `url` in the browser once `port` is accepting connections, polling for
 * up to ~10s. Used for the Vite dev server, which binds the port asynchronously
 * after spawn — opening immediately would load the tab before Vite is ready.
 */
async function openBrowserWhenReady(url: string, port: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await probePort(port, "127.0.0.1")) {
      openBrowser(url);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function runWebInterface(
  flagEnvVars: Record<string, string>,
  parsedFlagOverrides: Record<string, boolean | string>,
  disablePlatform: boolean,
  openInBrowser: boolean,
): Promise<void> {
  // Propagate flag env vars so child processes (e.g. hatch from the web UI) inherit them.
  Object.assign(process.env, flagEnvVars);

  // Prefer Vite dev server in source checkouts for full local-mode support
  // (HMR, __local endpoints, gateway proxy).
  const webSourceDir = findWebSourceDir();
  if (webSourceDir) {
    return runViteDevServer(
      webSourceDir,
      flagEnvVars,
      disablePlatform,
      openInBrowser,
    );
  }

  const distDir = findWebDistDir();
  if (!distDir) {
    console.error(
      `${ANSI.bold}--interface web${ANSI.reset}: unable to locate ` +
        `@vellumai/web assets.\n\n` +
        `  npm/bunx install:   npm install @vellumai/web\n` +
        `  source checkout:    cd clients/web && VITE_PLATFORM_MODE=false bun run build`,
    );
    process.exit(1);
  }

  const rawIndexHtml = await Bun.file(path.join(distDir, "index.html")).text();
  const platformUrl = getPlatformUrl();
  const webUrl = getWebUrl();
  const safeJson = (v: unknown) =>
    JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const configJson = safeJson({ webUrl, platformUrl, disablePlatform });
  const hasOverrides = Object.keys(parsedFlagOverrides).length > 0;
  const flagOverridesSnippet = hasOverrides
    ? `;window.__VELLUM_FLAG_OVERRIDES__=${safeJson(parsedFlagOverrides)}`
    : "";
  const indexHtml = rawIndexHtml.replace(
    "</head>",
    `<script>window.__VELLUM_CONFIG__=${configJson}${flagOverridesSnippet}</script></head>`,
  );

  const fetchHandler: WebFetchHandler = async (req, server) => {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/" || pathname === "/assistant") {
      return Response.redirect(SPA_BASE, 302);
    }

    // WorkOS PKCE callback. Not under the __local guards — it arrives as a
    // top-level navigation from WorkOS; the state check is the defense.
    if (pathname === CALLBACK_PATH) {
      return webLoginFlow.handleCallback(url);
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

      // The DRF API authenticates by header (X-Session-Token); the allauth /
      // accounts session endpoints need the Django session cookie.
      const isApiRequest = pathname.startsWith("/v1/");

      // Authenticate with the loopback session token the SPA registered. Only
      // same-origin SPA traffic gets the credential — never a cross-site caller.
      const sessionToken = isSameOriginRequest(req)
        ? currentPlatformToken()
        : null;
      if (isApiRequest) {
        // Header-only auth for the DRF API. Sending a `sessionid` cookie would
        // engage Django's SessionAuthentication, which enforces CSRF — and the
        // proxy strips Origin/Referer above, so the CSRF Referer check would
        // reject every unsafe (POST/PUT/PATCH) request. Drop any browser cookie
        // (localhost jar) so it can't re-engage that path.
        headers.delete("Cookie");
        if (sessionToken) {
          headers.set("X-Session-Token", sessionToken);
        }
      } else if (sessionToken) {
        // allauth / accounts: the platform expects the Django session cookie.
        headers.set(
          "Cookie",
          `sessionid=${sessionToken}; __Secure-sessionid=${sessionToken}`,
        );
        headers.set("X-Session-Token", sessionToken);
      }

      try {
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        const body = hasBody ? await req.arrayBuffer() : undefined;
        const proxyRes = await loopbackSafeFetch(target.toString(), {
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
  };

  const { port, servers } = serveLoopback(3000, fetchHandler);
  if (port !== 3000) {
    console.log(`Port 3000 in use; using ${port}.`);
  }
  // Advertise `localhost` (not `127.0.0.1`); the PKCE callback 302s back to
  // `localhost` after login, so the user stays on one origin. We bind both
  // loopback families above so `localhost` reaches us whichever one it
  // resolves to.
  const webInterfaceUrl = `http://localhost:${port}${SPA_BASE}`;
  console.log(`Vellum web interface: ${webInterfaceUrl}`);
  if (openInBrowser) openBrowser(webInterfaceUrl);

  const shutdown = (): void => {
    for (const server of servers) server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

async function runViteDevServer(
  webSourceDir: string,
  flagEnvVars: Record<string, string>,
  disablePlatform: boolean,
  openInBrowser: boolean,
): Promise<void> {
  const platformUrl = getPlatformUrl();

  // Build VITE_VELLUM_FLAG_* vars so Vite exposes them to the browser bundle.
  const viteFlagVars: Record<string, string> = {};
  for (const [envName, value] of Object.entries(flagEnvVars)) {
    viteFlagVars[`VITE_${envName}`] = value;
  }

  // Auto-pick a free port (Vite uses strictPort) so a running `vel up` stack
  // on :3000 doesn't wedge dev. The loopback callback port follows
  // window.location.port, so a non-3000 port propagates automatically.
  const port = await findFreeDualLoopbackPort(3000);
  if (port !== 3000) {
    console.log(`Port 3000 in use; using ${port}.`);
  }

  const child = spawn("bun", ["run", "dev"], {
    cwd: webSourceDir,
    stdio: "inherit",
    env: {
      ...process.env,
      ...flagEnvVars,
      ...viteFlagVars,
      ...(disablePlatform ? { VITE_VELLUM_DISABLE_PLATFORM: "true" } : {}),
      VITE_PLATFORM_MODE: "false",
      API_PROXY_TARGET: platformUrl,
      VELLUM_WEB_URL: getWebUrl(),
      VELLUM_PLATFORM_URL: platformUrl,
      PORT: String(port),
    },
  });

  // Vite binds the port itself, so wait until it's listening before opening the
  // browser — otherwise the tab loads before the dev server is ready.
  if (openInBrowser) {
    void openBrowserWhenReady(`http://localhost:${port}${SPA_BASE}`, port);
  }

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

  // Only refresh once the stored token is actually due for renewal.
  if (!guardianTokenDueForRenewal(stored)) return bearerToken;

  // SECURITY: bind the refresh to the entry's persisted URL. `--url`/`-u` can
  // override `runtimeUrl` while still reusing this stored guardian token, so a
  // poisoned/attacker URL must not receive the long-lived refreshToken +
  // deviceId. Refresh only when the URL is one of the entry's persisted URLs,
  // and send to the trusted persisted URL — not the caller-supplied one.
  const lookup = lookupAssistantByIdentifier(assistantId);
  if (lookup.status !== "found") return bearerToken;
  const refreshUrl = trustedRefreshUrl(lookup.entry, runtimeUrl);
  if (!refreshUrl) return bearerToken;

  const refreshed = await refreshGuardianToken(refreshUrl, assistantId);
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
    flagEnvVars,
    parsedFlagOverrides,
    disablePlatform,
    openBrowser: openInBrowser,
  } = parseArgs();

  if (disablePlatform) {
    process.env.VELLUM_DISABLE_PLATFORM = "true";
  }

  if (interfaceId === WEB_INTERFACE_ID) {
    await runWebInterface(
      flagEnvVars,
      parsedFlagOverrides,
      disablePlatform,
      openInBrowser,
    );
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
