import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { cloudAssistantHubUrl } from "@vellumai/environments";

import {
  getAssistantDisplayName,
  lookupAssistantByIdentifier,
  type AssistantEntry,
} from "./assistant-config.js";
import { getCurrentEnvironment } from "./environments/resolve.js";
import { waitForDaemonReady } from "./http-client.js";
import {
  getDefaultWorkspaceDir,
  isLocalContainerEntry,
  loadRawConfig,
  parseGatewayPortFromEntryUrls,
  saveRawConfig,
} from "./ingress-config.js";
import { findWebDistDir } from "./web-dist.js";

export { findWebDistDir } from "./web-dist.js";

/**
 * CLI-managed nginx reverse proxy that fronts the gateway as the canonical
 * tunnel target: browser → tunnel (TLS) → nginx@127.0.0.1 → gateway@127.0.0.1.
 *
 * `vellum tunnel` (and the wake restore path) bring this edge up via
 * `ensureTunnelEdge` and always front its loopback listen port.
 */

export const DEFAULT_NGINX_INGRESS_PORT = 7840;

/** Listen port for nginx ingress, from VELLUM_NGINX_INGRESS_PORT. */
export function getNginxIngressPort(): number {
  const raw = process.env.VELLUM_NGINX_INGRESS_PORT;
  if (!raw) return DEFAULT_NGINX_INGRESS_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("VELLUM_NGINX_INGRESS_PORT must be a valid TCP port");
  }
  return value;
}

export interface IngressPaths {
  /** nginx prefix dir; conf, pidfile, and temp dirs live here. */
  dir: string;
  confPath: string;
  pidPath: string;
  logPath: string;
}

export function getIngressPaths(workspaceDir: string): IngressPaths {
  const dir = join(workspaceDir, "data", "ingress");
  return {
    dir,
    confPath: join(dir, "nginx.conf"),
    pidPath: join(dir, "nginx.pid"),
    logPath: join(workspaceDir, "data", "logs", "nginx-ingress.log"),
  };
}

function nginxQuoted(value: string, label: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} contains a control character`);
  }
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")}"`;
}

function nginxDirPath(dir: string): string {
  return dir.endsWith("/") ? dir : `${dir}/`;
}

function gatewayProxyBlock(gatewayPort: number): string {
  return `      proxy_pass http://127.0.0.1:${gatewayPort};
      proxy_http_version 1.1;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_read_timeout 1h;
      proxy_set_header Host $host;
      proxy_set_header X-Vellum-Edge-Forwarded "1";
      proxy_set_header X-Vellum-Client-Ip $vellum_edge_client_ip;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;`;
}

/**
 * Sensitive local-only routes the edge must never expose to the internet,
 * regardless of whether the SPA is being served.
 */
const DENYLIST_LOCATIONS = `    location = /auth/token { return 404; }
    location = /auth/token/ { return 404; }
    location = /v1/pair { return 404; }
    location = /v1/pair/ { return 404; }
    location = /v1/pair/web-init { return 404; }
    location = /v1/pair/web-init/ { return 404; }
    location = /v1/devices { return 404; }
    location = /v1/devices/ { return 404; }
    location = /v1/devices/revoke { return 404; }
    location = /v1/devices/revoke/ { return 404; }
    location = /v1/guardian/init { return 404; }
    location = /v1/guardian/init/ { return 404; }
    location = /v1/guardian/reset-bootstrap { return 404; }
    location = /v1/guardian/reset-bootstrap/ { return 404; }
    location = /v1/remote-web/pairing-requests { return 404; }
    location = /v1/remote-web/pairing-requests/ { return 404; }
    location = /v1/remote-web/pairing-requests/approve { return 404; }
    location = /v1/remote-web/pairing-requests/approve/ { return 404; }
    location = /v1/remote-web/pairing-requests/deny { return 404; }
    location = /v1/remote-web/pairing-requests/deny/ { return 404; }
    location = /v1/remote-web/pairing-verification { return 404; }
    location = /v1/remote-web/pairing-verification/ { return 404; }
    location ^~ /assistant/__local/ { return 404; }
    location ^~ /assistant/__gateway/ { return 404; }
    location ^~ /assistant/__gateway-paired/ { return 404; }`;

export interface RemoteWebIngressOptions {
  webDistDir: string;
  indexHtmlPath?: string;
  config?: Record<string, unknown>;
  /** Serving assistant's display name, stamped into the served config so
   *  remote clients can label this origin. Absent in older served configs. */
  assistantName?: string;
  /** Serving assistant's id, stamped into the served config so a caller can
   *  confirm which assistant an edge is fronting. Absent in older served
   *  configs. */
  assistantId?: string;
  /** Cloud web SPA base the remote client can hand this origin to (see
   *  `cloudWebHubUrl`). Absent in older served configs. */
  hubUrl?: string;
}

/**
 * Cloud web SPA base URL for a build environment. The mapping lives in
 * `@vellumai/environments` (`cloudAssistantHubUrl`) and is shared with the
 * Capacitor shell's `server.url`, so the two consumers cannot drift.
 */
export function cloudWebHubUrl(env: string | undefined): string {
  return cloudAssistantHubUrl(env);
}

function remoteWebIngressConfig(
  opts: Pick<
    RemoteWebIngressOptions,
    "config" | "assistantName" | "assistantId" | "hubUrl"
  >,
): Record<string, unknown> {
  return {
    mode: "remote-gateway",
    apiBaseUrl: "/v1",
    platformDisabled: true,
    disablePlatform: true,
    ...(opts.assistantName ? { assistantName: opts.assistantName } : {}),
    ...(opts.assistantId ? { assistantId: opts.assistantId } : {}),
    ...(opts.hubUrl ? { hubUrl: opts.hubUrl } : {}),
    ...opts.config,
  };
}

/**
 * Part of edge identity: a detached edge is reused only while its recorded
 * fingerprint matches, so this must change whenever the generated index or
 * nginx template does.
 */
const EDGE_TEMPLATE_VERSION = 5;

/**
 * Stable fingerprint of the SPA config injected into the served index and
 * `/assistant/__config`, plus the template that renders them. Recorded
 * alongside the edge state so a reuse decision can tell whether a running edge
 * already serves the requested config (see `IngressState.remoteWebConfigHash`).
 */
function remoteWebConfigFingerprint(config: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify({ template: EDGE_TEMPLATE_VERSION, config }))
    .digest("hex");
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

/**
 * Preloading the whole chunk graph opens ~290 tunnel connections on a cold
 * load, and one dropped request blanks the app before React can report it.
 * These are hints only; the entry module still pulls what it needs.
 */
function stripModulePreloads(html: string): string {
  return html.replace(/<link[^>]+rel="modulepreload"[^>]*>\s*/g, "");
}

export function buildRemoteWebIndexHtml(
  rawHtml: string,
  config: Record<string, unknown>,
): string {
  const html = stripModulePreloads(rawHtml);
  const script = `<script>window.__VELLUM_CONFIG__=${safeScriptJson(config)}</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${script}</head>`);
  }
  return `${script}${html}`;
}

/**
 * Whether the host has an IPv6 loopback to bind. False on Linux installs with
 * IPv6 disabled, where emitting the listener would make nginx exit at startup
 * rather than fall back to IPv4.
 */
export function hasIpv6Loopback(): boolean {
  return Object.values(networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .some((addr) => addr.address === "::1");
}

/**
 * Build the nginx config that forwards tunnel web traffic to the gateway.
 */
export function buildIngressNginxConfig(opts: {
  gatewayPort: number;
  listenPort: number;
  remoteWebIngress?: RemoteWebIngressOptions;
  /** Emit the `[::1]` listener. Off where the host has no IPv6 loopback,
   *  since nginx exits at startup when it cannot bind a listen address. */
  ipv6Loopback?: boolean;
}): string {
  const proxyBlock = gatewayProxyBlock(opts.gatewayPort);
  // A tunnel agent pointed at "localhost" reaches ::1 first on macOS, so an
  // IPv4-only bind refuses whichever share of a burst resolves that way.
  const ipv6Listen = opts.ipv6Loopback
    ? `    listen [::1]:${opts.listenPort};\n`
    : "";
  const remoteWebIngress = opts.remoteWebIngress;
  const serverLocations = remoteWebIngress
    ? buildRemoteWebIngressLocations({
        gatewayPort: opts.gatewayPort,
        webDistDir: remoteWebIngress.webDistDir,
        indexHtmlPath: remoteWebIngress.indexHtmlPath,
        config: remoteWebIngressConfig(remoteWebIngress),
      })
    : `${DENYLIST_LOCATIONS}

    location / {
${proxyBlock}
    }`;

  return `
worker_processes 1;
error_log stderr;
pid nginx.pid;

events {}

http {
  access_log off;
  default_type application/octet-stream;

  types {
    application/javascript js mjs;
    application/json json map;
    application/wasm wasm;
    font/woff woff;
    font/woff2 woff2;
    image/gif gif;
    image/jpeg jpeg jpg;
    image/png png;
    image/svg+xml svg svgz;
    image/webp webp;
    image/x-icon ico;
    text/css css;
    text/html html htm;
    text/plain txt;
  }

  map $http_upgrade $connection_upgrade {
    default upgrade;
    "" close;
  }

  # Edge-observed client address, stamped onto every proxied request as
  # X-Vellum-Client-Ip. proxy_set_header overwrites any inbound value, so a
  # remote client cannot smuggle one. Every caller reaches this loopback-only
  # listener through the TLS-terminating front (tunnel agent), so the raw peer
  # is always 127.0.0.1; the front records the real client as the RIGHTMOST
  # X-Forwarded-For entry (ngrok/cloudflared append, tailscale serve sets it),
  # which the remote client cannot control. Fall back to the raw peer when the
  # front sets no X-Forwarded-For.
  map $http_x_forwarded_for $vellum_edge_client_ip {
    default $remote_addr;
    "~,?\\s*(?<vellum_last_xff>[^,\\s]+)\\s*$" $vellum_last_xff;
  }

  server {
    listen 127.0.0.1:${opts.listenPort};
${ipv6Listen}    client_max_body_size 512m;

    # This edge sits behind a TLS-terminating front (tunnel or tailscale serve),
    # so redirects must be relative: emit "Location: /assistant/" and let the
    # client resolve it against the origin it used, rather than an absolute URL
    # built from nginx's own loopback scheme and port.
    absolute_redirect off;
    port_in_redirect off;

${serverLocations}
  }
}
`;
}

function buildRemoteWebIngressLocations(opts: {
  gatewayPort: number;
  webDistDir: string;
  indexHtmlPath?: string;
  config: Record<string, unknown>;
}): string {
  const proxyBlock = gatewayProxyBlock(opts.gatewayPort);
  const webDistDir = nginxDirPath(opts.webDistDir);
  const webAssetsDir = join(opts.webDistDir, "assets");
  const indexHtmlPath =
    opts.indexHtmlPath ?? join(opts.webDistDir, "index.html");
  const configJson = JSON.stringify(opts.config);

  return `${DENYLIST_LOCATIONS}

    location = /healthz {
${proxyBlock}
    }

    location = /readyz {
${proxyBlock}
    }

    location ^~ /v1/ {
${proxyBlock}
    }

    location ^~ /webhooks/ {
${proxyBlock}
    }

    location = /assistant {
      return 302 /assistant/;
    }

    location = /assistant/ {
      rewrite ^ /assistant/__remote-index.html last;
    }

    location = /assistant/index.html {
      rewrite ^ /assistant/__remote-index.html last;
    }

    location = /assistant/__remote-index.html {
      internal;
      alias ${nginxQuoted(indexHtmlPath, "remote web ingress index path")};
      add_header Cache-Control "no-store";
    }

    location = /assistant/__config {
      default_type application/json;
      add_header Cache-Control "no-store";
      return 200 ${nginxQuoted(configJson, "remote web ingress config")};
    }

    location ^~ /assistant/assets/ {
      alias ${nginxQuoted(nginxDirPath(webAssetsDir), "web assets path")};
      try_files $uri =404;
      add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location ^~ /assistant/ {
      alias ${nginxQuoted(webDistDir, "web dist path")};
      try_files $uri $uri/ /assistant/__remote-index.html;
      add_header Cache-Control "no-store";
    }

    location = / {
      return 302 /assistant/;
    }

    location / {
      return 404;
    }`;
}

function nginxBin(): string {
  return process.env.NGINX_BIN || "nginx";
}

/**
 * Check whether nginx is installed and accessible.
 * Returns the version string if installed, null otherwise.
 * (nginx prints its version to stderr.)
 */
export function getNginxVersion(): string | null {
  const result = spawnSync(nginxBin(), ["-v"], {
    encoding: "utf-8",
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) return null;
  const output = `${result.stderr || ""}${result.stdout || ""}`.trim();
  return output || null;
}

/*
 * PID handling is deliberately self-contained rather than reusing the
 * process.ts helpers: stopProcessByPidFile's isVellumProcess() guard only
 * matches command lines containing a vellum path, which fails for a custom
 * VELLUM_WORKSPACE_DIR and would silently leave nginx running (the same
 * reason local.ts kills ngrok directly). This module is also imported by
 * sleep/retire, whose tests mock.module() process.js process-globally —
 * depending on it here would couple this lib's behavior to those mocks.
 */

function readPidFile(pidPath: string): number | null {
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a PID belongs to this ingress nginx process.
 *
 * Matching only the executable name is not enough: a stale pidfile can point
 * at a system nginx or another assistant's ingress after PID reuse.
 */
function isIngressNginxProcess(pid: number, paths: IngressPaths): boolean {
  try {
    const output = execFileSync(
      "ps",
      ["-ww", "-p", String(pid), "-o", "command="],
      {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return (
      /nginx/.test(output) &&
      output.includes(paths.dir) &&
      output.includes(paths.confPath)
    );
  } catch {
    return false;
  }
}

/** The ingress nginx PID when it is recorded and alive, null otherwise. */
export function getIngressPid(workspaceDir: string): number | null {
  const paths = getIngressPaths(workspaceDir);
  const pid = readPidFile(paths.pidPath);
  return pid !== null && isPidAlive(pid) && isIngressNginxProcess(pid, paths)
    ? pid
    : null;
}

export function isIngressRunning(workspaceDir: string): boolean {
  return getIngressPid(workspaceDir) !== null;
}

export interface IngressState {
  listenPort: number;
  /**
   * Edge mode: SPA + proxy (true) or webhooks-only proxy (false). A persisted
   * record without this field represents an SPA edge.
   */
  includeWebApp: boolean;
  /**
   * Gateway port the edge's proxy_pass targets. Undefined in state records
   * that predate the field; callers treat an unknown port as unverified and
   * restart the edge so the running config provably targets the requested
   * port and the state is stamped for future comparisons.
   */
  gatewayPort?: number;
  /**
   * Fingerprint of the SPA config injected into the served index. Undefined
   * for webhooks-only edges and for SPA records that predate the field; an
   * SPA edge without a recorded fingerprint is treated as drifted and
   * restarted so the served index provably carries the requested config.
   */
  remoteWebConfigHash?: string;
}

export function readIngressState(workspaceDir: string): IngressState | null {
  const config = loadRawConfig(workspaceDir);
  const ingress = config.ingress as Record<string, unknown> | undefined;
  const nginx = ingress?.nginx as Record<string, unknown> | undefined;
  const listenPort = nginx?.listenPort;
  if (typeof listenPort !== "number") return null;
  const gatewayPort = nginx?.gatewayPort;
  const remoteWebConfigHash = nginx?.remoteWebConfigHash;
  return {
    listenPort,
    includeWebApp: nginx?.includeWebApp !== false,
    ...(typeof gatewayPort === "number" ? { gatewayPort } : {}),
    ...(typeof remoteWebConfigHash === "string" ? { remoteWebConfigHash } : {}),
  };
}

function saveIngressState(workspaceDir: string, state: IngressState): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  ingress.nginx = {
    listenPort: state.listenPort,
    includeWebApp: state.includeWebApp,
    ...(state.gatewayPort !== undefined
      ? { gatewayPort: state.gatewayPort }
      : {}),
    ...(state.remoteWebConfigHash !== undefined
      ? { remoteWebConfigHash: state.remoteWebConfigHash }
      : {}),
  };
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
}

function clearIngressState(workspaceDir: string): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = config.ingress as Record<string, unknown> | undefined;
  if (!ingress) return;
  delete ingress.nginx;
  saveRawConfig(workspaceDir, config);
}

function clearStoppedIngress(workspaceDir: string, pidPath: string): void {
  clearIngressState(workspaceDir);
  rmSync(pidPath, { force: true });
}

/**
 * Write the nginx config and spawn nginx detached (same idiom as the ngrok
 * spawn in ngrok.ts: stdout/stderr to a log file, fd closed after spawn,
 * caller unrefs). nginx runs with `daemon off` so the spawned process is the
 * master; it writes its pid to nginx.pid under the prefix dir.
 */
export function startIngressNginx(opts: {
  workspaceDir: string;
  gatewayPort: number;
  listenPort: number;
  remoteWebIngress?: RemoteWebIngressOptions;
}): ChildProcess {
  const paths = getIngressPaths(opts.workspaceDir);
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(join(opts.workspaceDir, "data", "logs"), { recursive: true });
  const remoteWebIngress = opts.remoteWebIngress
    ? {
        ...opts.remoteWebIngress,
        config: remoteWebIngressConfig(opts.remoteWebIngress),
        indexHtmlPath: join(paths.dir, "assistant-index.html"),
      }
    : undefined;
  if (remoteWebIngress) {
    const rawIndexHtml = readFileSync(
      join(remoteWebIngress.webDistDir, "index.html"),
      "utf-8",
    );
    writeFileSync(
      remoteWebIngress.indexHtmlPath,
      buildRemoteWebIndexHtml(rawIndexHtml, remoteWebIngress.config),
    );
  }
  writeFileSync(
    paths.confPath,
    buildIngressNginxConfig({
      gatewayPort: opts.gatewayPort,
      listenPort: opts.listenPort,
      remoteWebIngress,
      ipv6Loopback: hasIpv6Loopback(),
    }),
  );

  const fd = openSync(paths.logPath, "a");
  const child = spawn(
    nginxBin(),
    ["-p", paths.dir, "-c", paths.confPath, "-g", "daemon off;"],
    { detached: true, stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);

  saveIngressState(opts.workspaceDir, {
    listenPort: opts.listenPort,
    includeWebApp: opts.remoteWebIngress !== undefined,
    gatewayPort: opts.gatewayPort,
    ...(remoteWebIngress
      ? {
          remoteWebConfigHash: remoteWebConfigFingerprint(
            remoteWebIngress.config,
          ),
        }
      : {}),
  });
  return child;
}

const STOP_TIMEOUT_MS = 2_000;

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isPidAlive(pid);
}

/**
 * Stop a running ingress nginx via its pidfile and clear the recorded state.
 * Returns true if a process was stopped.
 *
 * Verifies the PID still belongs to this ingress nginx before killing to avoid
 * hitting an unrelated process if the OS has reused the PID. SIGTERM is nginx
 * fast shutdown; escalate to SIGKILL if it doesn't exit within the timeout.
 */
export async function stopIngressNginx(workspaceDir: string): Promise<boolean> {
  const paths = getIngressPaths(workspaceDir);

  const pid = readPidFile(paths.pidPath);
  if (pid === null || !isPidAlive(pid) || !isIngressNginxProcess(pid, paths)) {
    clearStoppedIngress(workspaceDir, paths.pidPath);
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    if (!(await waitForPidExit(pid, STOP_TIMEOUT_MS))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        if (!isPidAlive(pid)) {
          clearStoppedIngress(workspaceDir, paths.pidPath);
          return true;
        }
        return false;
      }
      if (!(await waitForPidExit(pid, STOP_TIMEOUT_MS))) {
        return false;
      }
    }
  } catch {
    if (!isPidAlive(pid)) {
      clearStoppedIngress(workspaceDir, paths.pidPath);
      return true;
    }
    return false;
  }

  clearStoppedIngress(workspaceDir, paths.pidPath);
  return true;
}

/** Probe budget for confirming the freshly-spawned edge answers /healthz. */
export const INGRESS_READY_TIMEOUT_MS = 5_000;

/**
 * Settle budget for the spawned nginx to prove port ownership: a healthy
 * master records its pid under our prefix within milliseconds, while one that
 * lost the bind exits. Bounds the wait for whichever happens first.
 */
// The settle window must outlast nginx's internal bind-retry loop (5 attempts
// with 500ms sleeps) so a contested bind resolves to a child exit rather than
// a timeout while the child is still retrying.
const OWNERSHIP_SETTLE_TIMEOUT_MS = 4_000;
const OWNERSHIP_SETTLE_INTERVAL_MS = 100;

/**
 * Outcome of an attempt to bring up the nginx ingress edge. Callers render
 * their own messaging per variant: `ensureTunnelEdge` maps failure variants to
 * thrown errors with actionable text, which `vellum tunnel` and
 * `nginx-ingress up` print before exiting non-zero while the wake restore path
 * warns and continues.
 */
export type StartRemoteWebIngressResult =
  | {
      status: "started";
      listenPort: number;
      /** SPA dist directory served by the edge; null in webhooks-only mode. */
      webDistDir: string | null;
      version: string;
    }
  | {
      status: "already-running";
      /** Recorded listen port of the running edge (requested port when no state is recorded). */
      listenPort: number;
      /** Recorded edge mode; a running edge without a state record reports the SPA default. */
      includeWebApp: boolean;
      /** Recorded gateway upstream; undefined when the record predates the field. */
      gatewayPort?: number;
      /**
       * Set when the surviving edge matches the requested mode and gateway
       * port but serves a different injected SPA config than requested (a
       * restart was attempted and failed), so the served index is stale.
       */
      staleRemoteWebConfig?: true;
    }
  | { status: "nginx-missing" }
  | { status: "web-dist-missing" }
  | { status: "unreachable"; listenPort: number; logPath: string }
  | { status: "port-conflict"; listenPort: number; logPath: string };

/**
 * Generate the nginx config and start the remote-web ingress edge, probe
 * /healthz through it to prove the ingress → gateway path is live, and confirm
 * via the recorded pid file that the spawned nginx owns the listen port. A
 * spawned but unreachable or unowned nginx is rolled back so a failed attempt
 * leaves no half-up edge behind.
 *
 * An edge already running in the requested mode, against the requested
 * gateway port, and serving the requested injected SPA config short-circuits
 * as `already-running`; one running in the other mode (SPA vs webhooks-only),
 * against a different gateway port, or serving a drifted SPA config (e.g. a
 * renamed assistant or an updated hub URL) is stopped and restarted with the
 * requested config.
 *
 * Pure mechanism: it performs no console output and never exits the process, so
 * every edge caller (`vellum tunnel`, `nginx-ingress up`, the wake restore
 * path) can share one implementation and map the returned result to its own UX.
 */
export async function startRemoteWebIngress(opts: {
  workspaceDir: string;
  gatewayPort: number;
  listenPort?: number;
  readyTimeoutMs?: number;
  /**
   * Serve the web SPA from the edge (default true). When false the web-dist
   * preflight is skipped and the edge only proxies gateway traffic behind the
   * sensitive-route denylist (webhooks-only mode).
   */
  includeWebApp?: boolean;
  /**
   * Serving assistant's display name, stamped into the served remote-web
   * config (`__VELLUM_CONFIG__.assistantName`) so remote clients can label
   * this origin. Omitted when unknown; consumers tolerate its absence.
   */
  assistantName?: string;
  /**
   * Serving assistant's id, stamped into the served remote-web config
   * (`__VELLUM_CONFIG__.assistantId`) so a caller probing this origin can
   * confirm which assistant the edge fronts. Omitted when unknown.
   */
  assistantId?: string;
  /**
   * Invoked once, after every preflight check passes and immediately before
   * nginx is spawned, so callers can emit their own "starting" progress line
   * with the resolved version/dist/port (webDistDir is null in webhooks-only
   * mode). Never fires on a preflight bail-out (nginx-missing,
   * already-running, web-dist-missing).
   */
  onStarting?: (info: {
    version: string;
    webDistDir: string | null;
    listenPort: number;
  }) => void;
}): Promise<StartRemoteWebIngressResult> {
  const listenPort = opts.listenPort ?? getNginxIngressPort();
  const includeWebApp = opts.includeWebApp ?? true;

  const version = getNginxVersion();
  if (!version) {
    return { status: "nginx-missing" };
  }

  const running = isIngressRunning(opts.workspaceDir);
  const recorded = running ? readIngressState(opts.workspaceDir) : null;
  const recordedMode = recorded?.includeWebApp ?? true;
  // The SPA config the served index must carry, computed up front so the
  // reuse decision and the actual spawn share one value and cannot drift.
  const spaOptions = includeWebApp
    ? {
        hubUrl: cloudWebHubUrl(getCurrentEnvironment().name),
        ...(opts.assistantName ? { assistantName: opts.assistantName } : {}),
        ...(opts.assistantId ? { assistantId: opts.assistantId } : {}),
      }
    : undefined;
  const requestedConfigHash = spaOptions
    ? remoteWebConfigFingerprint(remoteWebIngressConfig(spaOptions))
    : undefined;
  // Both sides are undefined in webhooks-only mode; an SPA record without a
  // fingerprint predates the field and counts as drifted (see IngressState).
  const configMatches = recorded?.remoteWebConfigHash === requestedConfigHash;
  const alreadyRunning = (): StartRemoteWebIngressResult => ({
    status: "already-running",
    listenPort: recorded?.listenPort ?? listenPort,
    includeWebApp: recordedMode,
    ...(recorded?.gatewayPort !== undefined
      ? { gatewayPort: recorded.gatewayPort }
      : {}),
    ...(recordedMode === includeWebApp &&
    recorded?.gatewayPort === opts.gatewayPort &&
    !configMatches
      ? { staleRemoteWebConfig: true as const }
      : {}),
  });
  // An unknown recorded gateway port is unverified (see IngressState).
  if (
    running &&
    recordedMode === includeWebApp &&
    recorded?.gatewayPort === opts.gatewayPort &&
    configMatches
  ) {
    return alreadyRunning();
  }

  let webDistDir: string | null = null;
  if (includeWebApp) {
    webDistDir = findWebDistDir();
    if (!webDistDir) {
      return { status: "web-dist-missing" };
    }
  }

  // The running edge serves the other mode, targets a different gateway
  // port, or injects a stale SPA config; restart it with the requested
  // config. A false stop can mean the old edge exited on its own after the
  // check above, so recheck liveness and only bail when it is still serving.
  if (
    running &&
    !(await stopIngressNginx(opts.workspaceDir)) &&
    isIngressRunning(opts.workspaceDir)
  ) {
    return alreadyRunning();
  }

  opts.onStarting?.({ version, webDistDir, listenPort });

  const child = startIngressNginx({
    workspaceDir: opts.workspaceDir,
    gatewayPort: opts.gatewayPort,
    listenPort,
    remoteWebIngress: webDistDir ? { webDistDir, ...spaOptions } : undefined,
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();

  // /healthz proxies through nginx to the gateway, so a 200 proves the whole
  // ingress → gateway path works.
  const ready = await waitForDaemonReady(
    listenPort,
    opts.readyTimeoutMs ?? INGRESS_READY_TIMEOUT_MS,
  );
  const rollback = async (
    status: "port-conflict" | "unreachable",
  ): Promise<StartRemoteWebIngressResult> => {
    const { logPath } = getIngressPaths(opts.workspaceDir);
    await stopIngressNginx(opts.workspaceDir);
    return { status, listenPort, logPath };
  };
  const childExited = (): boolean => exited || child.exitCode !== null;
  // nginx runs `daemon off`, so the spawned process is the master and stays
  // alive while the edge serves. An early exit means startup failed: a dead
  // spawn is reported as a port conflict even when the probe succeeded, since
  // that probe reached some other process bound to the port (e.g. another
  // assistant's edge), not this one.
  if (!ready) {
    return rollback(childExited() ? "port-conflict" : "unreachable");
  }
  // A successful probe alone does not prove ownership either: a healthy edge
  // from another workspace answers /healthz before our master finishes failing
  // its bind. A master that won the bind records its pid under our prefix, so
  // settle-poll until the spawn either exits (lost the bind) or that pid file
  // names a live ingress nginx of ours (owns the port).
  const deadline = Date.now() + OWNERSHIP_SETTLE_TIMEOUT_MS;
  for (;;) {
    if (childExited()) {
      break;
    }
    if (getIngressPid(opts.workspaceDir) !== null) {
      return { status: "started", listenPort, webDistDir, version };
    }
    if (Date.now() >= deadline) {
      // The child is alive but never proved ownership. Kill it before rolling
      // back: it may still be inside nginx's bind-retry loop, and an orphan
      // that later wins the bind would serve with no recorded state.
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone; the rollback below clears any remaining state.
      }
      break;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, OWNERSHIP_SETTLE_INTERVAL_MS),
    );
  }
  return rollback("port-conflict");
}

/**
 * Display name recorded for the assistant in the CLI lockfile; undefined when
 * no entry matches, so the served config omits the label rather than guessing.
 */
function lockfileAssistantName(assistantId: string): string | undefined {
  const result = lookupAssistantByIdentifier(assistantId);
  return result.status === "found"
    ? getAssistantDisplayName(result.entry)
    : undefined;
}

/** User-facing label for the edge mode, shared by every edge status line. */
export function formatEdgeMode(includesWebApp: boolean): string {
  return includesWebApp ? "remote web + webhooks" : "webhooks only";
}

/**
 * Stop the tunnel edge fronting a container assistant, if this assistant is
 * the one it currently fronts.
 *
 * Container topologies share one default-workspace edge (one pidfile, one
 * listen port), so the recorded `gatewayPort` is what attributes it. Without
 * that check this would tear down another assistant's working tunnel; a record
 * with no recorded port cannot be attributed, so it is left alone.
 */
export async function stopContainerTunnelEdge(
  entry: AssistantEntry,
): Promise<boolean> {
  if (!isLocalContainerEntry(entry)) {
    return false;
  }
  const gatewayPort = parseGatewayPortFromEntryUrls(entry);
  if (gatewayPort === undefined) {
    return false;
  }
  const workspaceDir = getDefaultWorkspaceDir();
  if (!isIngressRunning(workspaceDir)) {
    return false;
  }
  if (readIngressState(workspaceDir)?.gatewayPort !== gatewayPort) {
    return false;
  }
  return stopIngressNginx(workspaceDir);
}

/** Resolved edge a tunnel (or bring-your-own HTTPS front) should target. */
export interface TunnelEdge {
  /** Loopback listen port the HTTPS front should forward to. */
  port: number;
  /** True when this call started the edge, false when a running one was reused. */
  started: boolean;
  includesWebApp: boolean;
}

/**
 * Recovery text for a drifted edge that outlived the automatic restart.
 * `startRemoteWebIngress` already escalated SIGTERM to SIGKILL before
 * reporting `already-running`, so the only thing left is the wedged process
 * itself: name its PID and log so the user can clear it by hand.
 */
function stuckEdgeRecoveryHint(workspaceDir: string): string {
  const { logPath } = getIngressPaths(workspaceDir);
  const pid = getIngressPid(workspaceDir);
  const target = pid !== null ? `the nginx process (PID ${pid})` : "it";
  return (
    `Vellum could not stop ${target}, even with SIGKILL. ` +
    `Stop it by hand and retry, or run \`vellum sleep\` to shut the ` +
    `assistant down entirely. Check the nginx log: ${logPath}`
  );
}

/**
 * Bring up the nginx edge as the canonical tunnel target and return the listen
 * port a tunnel should front.
 *
 * The edge always serves the SPA alongside the gateway proxy. The requested
 * mode is always delegated to `startRemoteWebIngress`, which reuses a running
 * edge that already serves that mode, gateway port, and injected SPA config
 * and restarts one that drifted in any respect, so the returned port always
 * fronts the requested config. `started` is false when a matching edge was
 * reused; a drifted edge that survives the restart attempt throws rather than
 * reporting the wrong config. Failures throw with actionable install or
 * diagnostic text.
 */
export async function ensureTunnelEdge(opts: {
  assistantId: string | undefined;
  workspaceDir: string;
  gatewayPort: number;
  /** Forwarded to `startRemoteWebIngress` for caller progress output. */
  onStarting?: (info: {
    version: string;
    webDistDir: string | null;
    listenPort: number;
  }) => void;
}): Promise<TunnelEdge> {
  const assistantName = opts.assistantId
    ? lockfileAssistantName(opts.assistantId)
    : undefined;

  const result = await startRemoteWebIngress({
    workspaceDir: opts.workspaceDir,
    gatewayPort: opts.gatewayPort,
    includeWebApp: true,
    ...(assistantName ? { assistantName } : {}),
    ...(opts.assistantId ? { assistantId: opts.assistantId } : {}),
    ...(opts.onStarting ? { onStarting: opts.onStarting } : {}),
  });

  switch (result.status) {
    case "started":
      return {
        port: result.listenPort,
        started: true,
        includesWebApp: true,
      };
    case "already-running": {
      // `already-running` also covers a drifted edge whose restart failed, so
      // trust the recorded state it carries over the requested config.
      if (!result.includeWebApp) {
        throw new Error(
          "The nginx edge is still running in webhooks-only mode " +
            "and could not be restarted in web app mode. " +
            stuckEdgeRecoveryHint(opts.workspaceDir),
        );
      }
      if (result.gatewayPort !== opts.gatewayPort) {
        const upstream =
          result.gatewayPort !== undefined
            ? `still proxying gateway port ${result.gatewayPort}`
            : "proxying an unknown gateway port";
        throw new Error(
          `The nginx edge is ${upstream} ` +
            `and could not be restarted against port ${opts.gatewayPort}. ` +
            stuckEdgeRecoveryHint(opts.workspaceDir),
        );
      }
      if (result.staleRemoteWebConfig) {
        throw new Error(
          "The nginx edge is still serving an outdated remote web config " +
            "and could not be restarted with the updated one. " +
            stuckEdgeRecoveryHint(opts.workspaceDir),
        );
      }
      return {
        port: result.listenPort,
        started: false,
        includesWebApp: result.includeWebApp,
      };
    }
    case "nginx-missing":
      throw new Error(
        "nginx is not installed, so the tunnel edge cannot start. " +
          "Install it (macOS: `brew install nginx`, Linux: `sudo apt install nginx`) " +
          "or point NGINX_BIN at an existing binary.",
      );
    case "web-dist-missing":
      throw new Error(
        "Unable to locate built web assets for the remote web edge. " +
          "Build the SPA (`cd clients/web && VITE_PLATFORM_MODE=false bun run build`) " +
          "or install @vellumai/web so its packaged dist directory is available.",
      );
    case "unreachable":
      throw new Error(
        `nginx edge did not become reachable on 127.0.0.1:${result.listenPort}. ` +
          `Check the nginx log: ${result.logPath}`,
      );
    case "port-conflict":
      throw new Error(
        `nginx edge exited on startup, most likely because 127.0.0.1:${result.listenPort} ` +
          "is already in use (for example by another assistant's tunnel edge). " +
          "Stop whatever is bound to that port, or pick a different edge port by " +
          "setting the VELLUM_NGINX_INGRESS_PORT environment variable, then retry. " +
          `Check the nginx log: ${result.logPath}`,
      );
  }
}
