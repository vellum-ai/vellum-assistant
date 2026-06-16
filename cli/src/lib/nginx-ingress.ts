import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { GATEWAY_PORT } from "./constants.js";

/**
 * CLI-managed nginx reverse proxy that fronts the gateway for remote web
 * ingress: browser → tunnel (TLS) → nginx@127.0.0.1 → gateway@127.0.0.1.
 *
 * While this proxy is running, `vellum tunnel` targets nginx's loopback listen
 * port instead of the gateway port.
 */

export const DEFAULT_NGINX_INGRESS_PORT = 7840;
const _require = createRequire(import.meta.url);

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

function getConfigPath(workspaceDir: string): string {
  return join(workspaceDir, "config.json");
}

function loadRawConfig(workspaceDir: string): Record<string, unknown> {
  const configPath = getConfigPath(workspaceDir);
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

function saveRawConfig(
  workspaceDir: string,
  config: Record<string, unknown>,
): void {
  const configPath = getConfigPath(workspaceDir);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Locate the pre-built @vellumai/web dist directory.
 *
 * Resolution order:
 *   1. npm-installed package — require.resolve('@vellumai/web/package.json')
 *   2. Source checkout — walk up from cli/ to find apps/web/dist/
 */
export function findWebDistDir(): string | null {
  try {
    const pkgPath = _require.resolve("@vellumai/web/package.json");
    const distDir = join(dirname(pkgPath), "dist");
    if (existsSync(join(distDir, "index.html"))) {
      return distDir;
    }
  } catch {
    // Package not installed; try source checkout.
  }

  let dir = import.meta.dir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "apps", "web", "dist", "index.html");
    if (existsSync(candidate)) {
      return dirname(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;`;
}

export interface RemoteWebIngressOptions {
  webDistDir: string;
  indexHtmlPath?: string;
  config?: Record<string, unknown>;
}

function remoteWebIngressConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    mode: "remote-gateway",
    apiBaseUrl: "/v1",
    platformDisabled: true,
    disablePlatform: true,
    ...config,
  };
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

export function buildRemoteWebIndexHtml(
  rawHtml: string,
  config: Record<string, unknown>,
): string {
  const script = `<script>window.__VELLUM_CONFIG__=${safeScriptJson(config)}</script>`;
  if (rawHtml.includes("</head>")) {
    return rawHtml.replace("</head>", `${script}</head>`);
  }
  return `${script}${rawHtml}`;
}

/**
 * Build the nginx config that forwards tunnel web traffic to the gateway.
 */
export function buildIngressNginxConfig(opts: {
  gatewayPort: number;
  listenPort: number;
  remoteWebIngress?: RemoteWebIngressOptions;
}): string {
  const proxyBlock = gatewayProxyBlock(opts.gatewayPort);
  const remoteWebIngress = opts.remoteWebIngress;
  const serverLocations = remoteWebIngress
    ? buildRemoteWebIngressLocations({
        gatewayPort: opts.gatewayPort,
        webDistDir: remoteWebIngress.webDistDir,
        indexHtmlPath: remoteWebIngress.indexHtmlPath,
        config: remoteWebIngressConfig(remoteWebIngress.config),
      })
    : `    location / {
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

  server {
    listen 127.0.0.1:${opts.listenPort};
    client_max_body_size 512m;

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

  return `    location = /auth/token { return 404; }
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
    location ^~ /assistant/__local/ { return 404; }
    location ^~ /assistant/__gateway/ { return 404; }

    location = /healthz {
${proxyBlock}
    }

    location ^~ /v1/ {
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

interface IngressState {
  listenPort: number;
}

function readIngressState(workspaceDir: string): IngressState | null {
  const config = loadRawConfig(workspaceDir);
  const ingress = config.ingress as Record<string, unknown> | undefined;
  const nginx = ingress?.nginx as Record<string, unknown> | undefined;
  const listenPort = nginx?.listenPort;
  if (typeof listenPort !== "number") return null;
  return { listenPort };
}

function saveIngressState(workspaceDir: string, state: IngressState): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  ingress.nginx = { listenPort: state.listenPort };
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
        config: remoteWebIngressConfig(opts.remoteWebIngress.config),
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
    }),
  );

  const fd = openSync(paths.logPath, "a");
  const child = spawn(
    nginxBin(),
    ["-p", paths.dir, "-c", paths.confPath, "-g", "daemon off;"],
    { detached: true, stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);

  saveIngressState(opts.workspaceDir, { listenPort: opts.listenPort });
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

/**
 * Resolve the local port a tunnel should target: the nginx ingress when it is
 * recorded AND its process is alive, otherwise the gateway port directly
 * (unchanged behavior when the proxy is not running).
 */
export function resolveTunnelTargetPort(
  workspaceDir: string,
  gatewayPort: number = GATEWAY_PORT,
  opts: { preferNginxIngress?: boolean } = {},
): { port: number; viaIngress: boolean } {
  if (opts.preferNginxIngress === false) {
    return { port: gatewayPort, viaIngress: false };
  }

  const state = readIngressState(workspaceDir);
  if (state && isIngressRunning(workspaceDir)) {
    return { port: state.listenPort, viaIngress: true };
  }
  return { port: gatewayPort, viaIngress: false };
}
