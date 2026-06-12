import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GATEWAY_PORT } from "./constants";
import { isProcessAlive, stopProcessByPidFile } from "./process.js";
import { loadRawConfig, saveRawConfig } from "./workspace-config.js";

/**
 * CLI-managed nginx reverse proxy that fronts the gateway for remote web
 * ingress: browser → tunnel (TLS) → nginx@127.0.0.1 → gateway@127.0.0.1.
 *
 * nginx is the layer that stamps the unspoofable edge marker and response
 * security headers; the tunnel (`vellum tunnel`) targets nginx's loopback
 * listen port instead of the gateway port while the ingress is running.
 */

export const DEFAULT_INGRESS_PORT = 7840;

/** Listen port for the ingress, from VELLUM_INGRESS_PORT (default 7840). */
export function getIngressPort(): number {
  const raw = process.env.VELLUM_INGRESS_PORT;
  if (!raw) return DEFAULT_INGRESS_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("VELLUM_INGRESS_PORT must be a valid TCP port");
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

/**
 * Build the nginx config that proxies gateway routes for remote ingress.
 *
 * Security properties (asserted by tests — do not weaken):
 * - Listens on 127.0.0.1 only; the tunnel agent bridges to the internet.
 * - Stamps `X-Vellum-Edge-Forwarded` on every proxied request.
 *   `proxy_set_header` REPLACES any client-supplied value of the same name, so
 *   a remote caller can neither forge nor strip the marker. The gateway treats
 *   marker-carrying requests as non-loopback regardless of X-Forwarded-For.
 *   The header name literal mirrors EDGE_FORWARDED_HEADER in
 *   gateway/src/http/edge-forwarded-header.ts — keep the two in sync.
 * - X-Forwarded-For is passed through as the tunnel provided it, for logging
 *   only. It must never drive trust decisions: the leftmost entry is
 *   client-influencable through appending tunnels, which is exactly why the
 *   marker exists. ($proxy_add_x_forwarded_for is deliberately not used.)
 */
export function buildIngressNginxConfig(opts: {
  gatewayPort: number;
  listenPort: number;
}): string {
  return `
worker_processes 1;
error_log stderr;
pid nginx.pid;

events {}

http {
  access_log off;

  map $http_upgrade $connection_upgrade {
    default upgrade;
    "" close;
  }

  server {
    listen 127.0.0.1:${opts.listenPort};
    client_max_body_size 512m;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;

    location / {
      proxy_pass http://127.0.0.1:${opts.gatewayPort};
      proxy_http_version 1.1;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_read_timeout 1h;
      proxy_set_header Host $host;
      proxy_set_header X-Vellum-Edge-Forwarded "1";
      proxy_set_header X-Forwarded-For $http_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
    }
  }
}
`;
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

export function isIngressRunning(workspaceDir: string): boolean {
  return isProcessAlive(getIngressPaths(workspaceDir).pidPath).alive;
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
}): ChildProcess {
  const paths = getIngressPaths(opts.workspaceDir);
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(join(opts.workspaceDir, "data", "logs"), { recursive: true });
  writeFileSync(
    paths.confPath,
    buildIngressNginxConfig({
      gatewayPort: opts.gatewayPort,
      listenPort: opts.listenPort,
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

/**
 * Stop a running ingress nginx via its pidfile and clear the recorded state.
 * Returns true if a process was stopped.
 */
export async function stopIngressNginx(workspaceDir: string): Promise<boolean> {
  const { pidPath } = getIngressPaths(workspaceDir);
  clearIngressState(workspaceDir);
  return stopProcessByPidFile(pidPath, "nginx ingress");
}

/**
 * Resolve the local port a tunnel should target: the nginx ingress when it is
 * recorded AND its process is alive, otherwise the gateway port directly
 * (unchanged legacy behavior).
 */
export function resolveTunnelTargetPort(
  workspaceDir: string,
  gatewayPort: number = GATEWAY_PORT,
): { port: number; viaIngress: boolean } {
  const state = readIngressState(workspaceDir);
  if (state && isIngressRunning(workspaceDir)) {
    return { port: state.listenPort, viaIngress: true };
  }
  return { port: gatewayPort, viaIngress: false };
}
