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
 * Build the nginx config that forwards tunnel web traffic to the gateway.
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

    location / {
      proxy_pass http://127.0.0.1:${opts.gatewayPort};
      proxy_http_version 1.1;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_read_timeout 1h;
      proxy_set_header Host $host;
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

/** Check whether a PID belongs to an nginx process via its command line. */
function isNginxProcess(pid: number): boolean {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /nginx/.test(output);
  } catch {
    return false;
  }
}

/** The ingress nginx PID when it is recorded and alive, null otherwise. */
export function getIngressPid(workspaceDir: string): number | null {
  const pid = readPidFile(getIngressPaths(workspaceDir).pidPath);
  return pid !== null && isPidAlive(pid) && isNginxProcess(pid) ? pid : null;
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
 * Verifies the PID still belongs to nginx before killing to avoid hitting an
 * unrelated process if the OS has reused the PID (the same pattern local.ts
 * uses for ngrok). SIGTERM is nginx fast shutdown; escalate to SIGKILL if it
 * doesn't exit within the timeout.
 */
export async function stopIngressNginx(workspaceDir: string): Promise<boolean> {
  const { pidPath } = getIngressPaths(workspaceDir);

  const pid = readPidFile(pidPath);
  if (pid === null || !isPidAlive(pid) || !isNginxProcess(pid)) {
    clearIngressState(workspaceDir);
    rmSync(pidPath, { force: true });
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    if (!(await waitForPidExit(pid, STOP_TIMEOUT_MS))) {
      process.kill(pid, "SIGKILL");
      if (!(await waitForPidExit(pid, STOP_TIMEOUT_MS))) {
        return false;
      }
    }
  } catch {
    return false;
  }

  clearIngressState(workspaceDir);
  rmSync(pidPath, { force: true });
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
