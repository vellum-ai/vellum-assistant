/**
 * Host proxy message router and daemon connection lifecycle.
 *
 * Listens for lockfile changes and maintains an SSE + poster pair for each
 * local assistant that has a gatewayPort. When an assistant appears, the
 * router obtains a guardian token and connects; when it disappears, it
 * disconnects. Incoming SSE messages are dispatched to pluggable executors;
 * unimplemented executors post error results so daemon requests don't hang.
 */

import {
  getGuardianAccessToken,
  resolveConfigDir,
  type CliInvocation,
} from "@vellumai/local-mode";
import type { Lockfile } from "@vellumai/local-mode/contract";

import { HostProxySseClient, type HostProxySseMessage } from "./host-proxy-sse";
import { HostProxyPoster } from "./host-proxy-poster";
import { hostBashExecutor } from "./executors/host-bash-executor";
import { hostFileExecutor } from "./executors/host-file-executor";
import { hostTransferExecutor } from "./executors/host-transfer-executor";
import { onLockfileChange, getWatchedLockfile } from "./lockfile-watcher";
import { HostBrowserExecutor } from "./executors/host-browser-executor";
import log from "./logger";

// ---------------------------------------------------------------------------
// Executor interface
// ---------------------------------------------------------------------------

export interface HostProxyExecutor {
  handleRequest(message: HostProxySseMessage, poster: HostProxyPoster): void;
  handleCancel(message: HostProxySseMessage, poster: HostProxyPoster): void;
}

// ---------------------------------------------------------------------------
// Connection entry
// ---------------------------------------------------------------------------

interface AssistantConnection {
  sse: HostProxySseClient;
  poster: HostProxyPoster;
  gatewayPort: number;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const connections = new Map<string, AssistantConnection>();
const executors = new Map<string, HostProxyExecutor>();

// Injected by installHostProxyBridge; kept at module scope so the
// lockfile-change listener (which cannot be async) can reference it.
let resolveCliInvocation: (() => Promise<CliInvocation>) | null = null;

// ---------------------------------------------------------------------------
// Executor registry
// ---------------------------------------------------------------------------

export function setExecutor(kind: string, executor: HostProxyExecutor): void {
  executors.set(kind, executor);
}

export function removeExecutor(kind: string): void {
  executors.delete(kind);
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

const EXECUTOR_KINDS = ["host_bash", "host_file", "host_transfer", "host_browser", "host_cu", "host_app_control"] as const;

/** Route type → executor kind. Returns null for unknown types. */
function executorKindForType(type: string): { kind: string; action: "request" | "cancel" } | null {
  for (const kind of EXECUTOR_KINDS) {
    if (type === `${kind}_request`) return { kind, action: "request" };
    if (type === `${kind}_cancel`) return { kind, action: "cancel" };
  }
  return null;
}

function dispatchMessage(message: HostProxySseMessage, poster: HostProxyPoster): void {
  const { type } = message;
  const route = executorKindForType(type);
  if (!route) {
    log.warn("[host-proxy-router] unknown message type, ignoring", { type });
    return;
  }

  const executor = executors.get(route.kind);

  if (executor) {
    if (route.action === "request") {
      executor.handleRequest(message, poster);
    } else {
      executor.handleCancel(message, poster);
    }
    return;
  }

  // No executor registered — post an error result so the daemon doesn't hang.
  const requestId = message.requestId as string | undefined;
  if (!requestId) {
    log.warn("[host-proxy-router] message missing requestId, cannot post stub error", { type });
    return;
  }

  log.warn("[host-proxy-router] executor not yet implemented", { type });

  switch (route.kind) {
    case "host_bash":
      void poster.postBashResult({
        requestId,
        stdout: "",
        stderr: "Executor not yet implemented",
        exitCode: 1,
        timedOut: false,
      });
      break;
    case "host_file":
      void poster.postFileResult({
        requestId,
        content: "Executor not yet implemented",
        isError: true,
      });
      break;
    case "host_transfer":
      void poster.postTransferResult({
        requestId,
        isError: true,
        errorMessage: "Executor not yet implemented",
      });
      break;
    case "host_browser":
      void poster.postBrowserResult({
        requestId,
        content: "Executor not yet implemented",
        isError: true,
      });
      break;
    case "host_cu":
      void poster.postCuResult({
        requestId,
        executionError: "Executor not yet implemented",
      });
      break;
    case "host_app_control":
      void poster.postAppControlResult({
        requestId,
        state: "missing",
        executionError: "Executor not yet implemented",
      });
      break;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle — connect / disconnect per assistant
// ---------------------------------------------------------------------------

/**
 * Exchange a guardian access token for a gateway JWT via POST /auth/token.
 * The daemon requires a JWT with aud=vellum-daemon or aud=vellum-gateway;
 * the raw guardian token is an opaque string that cannot authenticate
 * directly against daemon endpoints.
 */
async function exchangeForGatewayToken(
  gatewayPort: number,
  guardianToken: string,
): Promise<{ token: string; expiresAt: number } | null> {
  try {
    const url = `http://127.0.0.1:${gatewayPort}/auth/token`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${guardianToken}`,
        Origin: `http://127.0.0.1:${gatewayPort}`,
      },
    });
    if (!res.ok) {
      log.warn("[host-proxy-router] gateway token exchange failed", { status: res.status });
      return null;
    }
    const body = (await res.json()) as { token: string; expiresAt: number };
    return body;
  } catch (err) {
    log.warn("[host-proxy-router] gateway token exchange error", { err });
    return null;
  }
}

async function acquireGatewayToken(
  assistantId: string,
  gatewayPort: number,
): Promise<string | null> {
  if (!resolveCliInvocation) return null;

  const configDir = resolveConfigDir(process.env);

  let invocation: CliInvocation;
  try {
    invocation = await resolveCliInvocation();
  } catch (err) {
    log.error("[host-proxy-router] failed to resolve CLI invocation", { assistantId, err });
    return null;
  }

  const tokenResult = await getGuardianAccessToken(
    assistantId,
    configDir,
    invocation,
    true,
  );

  if (!tokenResult.ok) {
    log.warn("[host-proxy-router] failed to obtain guardian token", {
      assistantId,
      error: tokenResult.error,
    });
    return null;
  }

  const exchanged = await exchangeForGatewayToken(gatewayPort, tokenResult.accessToken);
  if (!exchanged) return null;

  return exchanged.token;
}

async function connectAssistant(
  assistantId: string,
  gatewayPort: number,
): Promise<void> {
  if (connections.has(assistantId)) return;

  const gatewayToken = await acquireGatewayToken(assistantId, gatewayPort);
  if (!gatewayToken) {
    log.warn("[host-proxy-router] could not acquire gateway token, skipping connection", { assistantId });
    return;
  }

  const refreshToken = async (): Promise<string | null> => {
    const fresh = await acquireGatewayToken(assistantId, gatewayPort);
    if (fresh) poster.updateAuthToken(fresh);
    return fresh;
  };

  const sse = new HostProxySseClient({ gatewayPort, authToken: gatewayToken, onRefreshToken: refreshToken });
  const poster = new HostProxyPoster({ gatewayPort, authToken: gatewayToken });

  sse.setMessageCallback((msg) => dispatchMessage(msg, poster));
  sse.connect();

  connections.set(assistantId, { sse, poster, gatewayPort });
  log.info("[host-proxy-router] connected to assistant", { assistantId, gatewayPort });
}

function disconnectAssistant(assistantId: string): void {
  const conn = connections.get(assistantId);
  if (!conn) return;
  conn.sse.disconnect();
  connections.delete(assistantId);
  log.info("[host-proxy-router] disconnected from assistant", { assistantId });
}

// ---------------------------------------------------------------------------
// Lockfile change handler
// ---------------------------------------------------------------------------

function handleLockfileChange(lockfile: Lockfile): void {
  const activeIds = new Set<string>();

  for (const assistant of lockfile.assistants) {
    const port = assistant.resources?.gatewayPort;
    if (!port) continue;
    activeIds.add(assistant.assistantId);

    const existing = connections.get(assistant.assistantId);
    if (!existing) {
      void connectAssistant(assistant.assistantId, port);
    } else if (existing.gatewayPort !== port) {
      log.info("[host-proxy-router] gateway port changed, reconnecting", {
        assistantId: assistant.assistantId,
        oldPort: existing.gatewayPort,
        newPort: port,
      });
      disconnectAssistant(assistant.assistantId);
      void connectAssistant(assistant.assistantId, port);
    }
  }

  // Disconnect assistants that are no longer in the lockfile
  for (const assistantId of connections.keys()) {
    if (!activeIds.has(assistantId)) {
      disconnectAssistant(assistantId);
    }
  }
}

// ---------------------------------------------------------------------------
// Public install / teardown
// ---------------------------------------------------------------------------

let unsubscribe: (() => void) | null = null;

/**
 * Wire the host proxy bridge into the app lifecycle. Call once from
 * `app.whenReady()` after `installLockfileWatcher()`. Returns a teardown
 * function for `before-quit`.
 */
export function installHostProxyBridge(
  cliResolver: () => Promise<CliInvocation>,
): () => void {
  resolveCliInvocation = cliResolver;
  setExecutor("host_bash", hostBashExecutor);
  setExecutor("host_file", hostFileExecutor);
  setExecutor("host_transfer", hostTransferExecutor);
  unsubscribe = onLockfileChange(handleLockfileChange);

  // Seed from any assistants already present in the lockfile
  const currentLockfile = getWatchedLockfile();
  if (currentLockfile.assistants.length > 0) {
    handleLockfileChange(currentLockfile);
  }

  // Register built-in executors
  const browserExecutor = new HostBrowserExecutor();
  setExecutor("host_browser", browserExecutor);

  return () => {
    unsubscribe?.();
    unsubscribe = null;
    for (const assistantId of [...connections.keys()]) {
      disconnectAssistant(assistantId);
    }
    browserExecutor.destroy();
    removeExecutor("host_browser");
    resolveCliInvocation = null;
  };
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export const __testing = {
  get connections() {
    return connections;
  },
  get executors() {
    return executors;
  },
  dispatchMessage,
  connectAssistant,
  disconnectAssistant,
  handleLockfileChange,
  reset() {
    for (const assistantId of [...connections.keys()]) {
      disconnectAssistant(assistantId);
    }
    executors.clear();
    resolveCliInvocation = null;
    unsubscribe?.();
    unsubscribe = null;
  },
};
