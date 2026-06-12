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

const LOCAL_ONLY_EXACT_PATHS = [
  "/auth/token",
  "/v1/pair",
  "/v1/devices",
  "/v1/devices/revoke",
  "/v1/guardian/init",
  "/v1/guardian/reset-bootstrap",
];

const GATEWAY_EXACT_PATHS = [
  "/.well-known/agent-card.json",
  "/healthz",
  "/readyz",
  "/schema",
  "/webhooks/telegram",
  "/webhooks/twilio/voice",
  "/webhooks/twilio/status",
  "/webhooks/twilio/connect-action",
  "/webhooks/twilio/voice-verify",
  "/webhooks/twilio/relay",
  "/webhooks/twilio/media-stream",
  "/webhooks/whatsapp",
  "/webhooks/email",
  "/webhooks/resend",
  "/webhooks/mailgun",
  "/webhooks/oauth/callback",
  "/inbound/register",
  "/integrations/status",
  "/v1/health",
  "/v1/healthz",
  "/v1/ps",
  "/v1/brain-graph",
  "/v1/brain-graph-ui",
  "/v1/contacts/guardian/channel",
  "/v1/contacts/prompt/submit",
  "/v1/contacts",
  "/v1/contacts/merge",
  "/v1/contacts/invites",
  "/v1/contacts/invites/redeem",
  "/v1/channel-verification-sessions",
  "/v1/channel-verification-sessions/resend",
  "/v1/channel-verification-sessions/status",
  "/v1/channel-verification-sessions/revoke",
  "/v1/guardian/refresh",
  "/v1/integrations/telegram/config",
  "/v1/integrations/telegram/commands",
  "/v1/integrations/telegram/setup",
  "/v1/integrations/vercel/config",
  "/v1/integrations/twilio/config",
  "/v1/integrations/twilio/credentials",
  "/v1/integrations/twilio/numbers",
  "/v1/integrations/twilio/numbers/provision",
  "/v1/integrations/twilio/numbers/assign",
  "/v1/integrations/twilio/numbers/release",
  "/v1/slack/channels",
  "/v1/slack/share",
  "/v1/oauth/providers",
  "/v1/oauth/apps",
  "/v1/admin/upgrade-broadcast",
  "/v1/admin/workspace-commit",
  "/v1/admin/rollback-migrations",
  "/v1/migrations/export",
  "/v1/migrations/import",
  "/v1/migrations/export-to-gcs",
  "/v1/migrations/import-from-gcs",
  "/v1/backups",
  "/v1/backups/create",
  "/v1/channels/readiness",
  "/v1/channels/readiness/refresh",
  "/v1/feature-flags",
  "/v1/config/privacy",
  "/v1/permissions/thresholds",
  "/v1/logs/export",
  "/v1/logs/tail",
  "/v1/trust-rules",
  "/v1/trust-rules/suggest",
];

const GATEWAY_REGEX_PATHS = [
  "^/webhooks/twilio/media-stream/",
  "^/v1/audio/[^/]+$",
  "^/v1/contact-channels/[^/]+$",
  "^/v1/contact-channels/[^/]+/verify$",
  "^/v1/contacts/invites/[^/]+$",
  "^/v1/contacts/invites/[^/]+/call$",
  "^/v1/contacts/(?!invites/?$)[^/]+/?$",
  "^/v1/assistants/[^/]+/contacts/(?!invites/?$)[^/]+/?$",
  "^/v1/oauth/providers/[^/]+/?$",
  "^/v1/oauth/apps/[^/]+/?$",
  "^/v1/oauth/apps/[^/]+/connections/?$",
  "^/v1/oauth/connections/[^/]+/?$",
  "^/v1/oauth/apps/[^/]+/connect/?$",
  "^/v1/migrations/import/[^/]+/status/?$",
  "^/v1/migrations/jobs/[^/]+/?$",
  "^/v1/assistants/[^/]+/backups/?$",
  "^/v1/assistants/[^/]+/backups/create/?$",
  "^/v1/assistants/[^/]+/channels/readiness/$",
  "^/v1/assistants/[^/]+/integrations/status/$",
  "^/v1/feature-flags/.+$",
  "^/v1/assistants/[^/]+/feature-flags/?$",
  "^/v1/assistants/[^/]+/feature-flags/.+$",
  "^/v1/assistants/[^/]+/config/privacy/$",
  "^/v1/assistants/[^/]+/permissions/thresholds/?$",
  "^/v1/permissions/thresholds/conversations/[^/]+/?$",
  "^/v1/assistants/[^/]+/permissions/thresholds/conversations/[^/]+/?$",
  "^/v1/trust-rules/[^/]+/reset$",
  "^/v1/trust-rules/[^/]+$",
  "^/v1/assistants/[^/]+/trust-rules/?$",
  "^/v1/assistants/[^/]+/trust-rules/suggest/?$",
  "^/v1/assistants/[^/]+/trust-rules/[^/]+/reset/?$",
  "^/v1/assistants/[^/]+/trust-rules/[^/]+/?$",
];

function buildProxyDirectives(gatewayPort: number): string {
  return `proxy_pass http://127.0.0.1:${gatewayPort};
      proxy_http_version 1.1;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_read_timeout 1h;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Host $host;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;`;
}

function buildExactLocation(path: string, body: string): string {
  return `    location = ${path} {
      ${body}
    }`;
}

function buildRegexLocation(pattern: string, body: string): string {
  return `    location ~ ${pattern} {
      ${body}
    }`;
}

/**
 * Build the nginx config that proxies gateway routes for remote ingress.
 *
 * Security properties (asserted by tests — do not weaken):
 * - Listens on 127.0.0.1 only; the tunnel agent bridges to the internet.
 * - Blocks local-only token/pair/bootstrap endpoints at the proxy.
 * - Proxies only gateway-owned routes; unknown paths never hit the runtime
 *   proxy catch-all in the gateway.
 * - Overwrites forwarded headers instead of appending client-supplied values.
 */
export function buildIngressNginxConfig(opts: {
  gatewayPort: number;
  listenPort: number;
}): string {
  const proxyDirectives = buildProxyDirectives(opts.gatewayPort);
  const blockedLocations = LOCAL_ONLY_EXACT_PATHS.map((path) =>
    buildExactLocation(path, "return 403;"),
  ).join("\n\n");
  const exactProxyLocations = GATEWAY_EXACT_PATHS.map((path) =>
    buildExactLocation(path, proxyDirectives),
  ).join("\n\n");
  const regexProxyLocations = GATEWAY_REGEX_PATHS.map((pattern) =>
    buildRegexLocation(pattern, proxyDirectives),
  ).join("\n\n");

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

${blockedLocations}

${exactProxyLocations}

${regexProxyLocations}

    location / {
      return 404;
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
  return pid !== null && isPidAlive(pid) ? pid : null;
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
  clearIngressState(workspaceDir);

  const pid = readPidFile(pidPath);
  let stopped = false;
  if (pid !== null && isPidAlive(pid) && isNginxProcess(pid)) {
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline && isPidAlive(pid)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isPidAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
    stopped = true;
  }
  rmSync(pidPath, { force: true });
  return stopped;
}

/**
 * Resolve the local port a tunnel should target: the nginx ingress when it is
 * recorded AND its process is alive, otherwise the gateway port directly
 * (unchanged behavior when the proxy is not running).
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
