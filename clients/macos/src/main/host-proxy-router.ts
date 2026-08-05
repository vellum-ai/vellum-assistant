/**
 * Host proxy message router and daemon connection lifecycle.
 *
 * Listens for lockfile changes and maintains an SSE + poster pair for each
 * assistant. Local assistants (with a gatewayPort) connect to the loopback
 * gateway; cloud/managed assistants connect to the platform via
 * assistant-scoped URLs with session-token auth; paired assistants connect to
 * the remote gateway at their runtimeUrl with the guardian access token as
 * the bearer.
 *
 * Incoming SSE messages are dispatched to pluggable executors; unimplemented
 * executors post error results so daemon requests don't hang.
 */

import {
  getGuardianAccessToken,
  resolveConfigDir,
  resolveEnvironmentName,
  type CliInvocation,
  type GuardianTokenOptions,
} from "@vellumai/local-mode";
import {
  isLoopbackGatewayCloud,
  isUsableRuntimeUrl,
  type Lockfile,
} from "@vellumai/local-mode/contract";

import { HostProxySseClient, type HostProxySseMessage } from "./host-proxy-sse";
import { HostProxyPoster } from "./host-proxy-poster";
import { hostBashExecutor } from "./executors/host-bash-executor";
import { hostFileExecutor } from "./executors/host-file-executor";
import { hostTransferExecutor } from "./executors/host-transfer-executor";
import { onLockfileChange, getWatchedLockfile } from "./lockfile-watcher";
import { HostBrowserExecutor } from "./executors/host-browser-executor";
import { hostCuExecutor } from "./executors/host-cu-executor";
import { hostAppControlExecutor } from "./executors/host-app-control-executor";
import { hostUiSnapshotExecutor } from "./executors/host-ui-snapshot-executor";
import { shutdownSharedCuHelper } from "./sidecar/shared-cu-helper";
import { getSessionToken } from "./session-token-store";
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
  /** Opaque string for detecting config changes that warrant a reconnect. */
  fingerprint: string;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const connections = new Map<string, AssistantConnection>();

// Connects that are still awaiting token acquisition. Registered synchronously
// before the first await so the lockfile reconcile pass can cancel them; a
// connect whose entry is gone (or replaced) when the await resolves must abort
// instead of opening SSE to a possibly stale target. Entries are compared by
// identity so a cancel-then-reconnect with the same fingerprint can't be
// completed by the superseded attempt.
interface PendingConnect {
  fingerprint: string;
}
const pendingConnects = new Map<string, PendingConnect>();

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

const EXECUTOR_KINDS = ["host_bash", "host_file", "host_transfer", "host_browser", "host_cu", "host_app_control", "host_ui_snapshot"] as const;

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
    // The gateway's /v1/events endpoint is the full assistant-event
    // firehose — streaming deltas (assistant_text_delta,
    // assistant_thinking_delta), tool events, sync notifications, and so
    // on. This connection exists only to service host_* proxy requests, so
    // every other event type is expected traffic we deliberately drop.
    // Only a host_*-shaped type we can't route is genuinely anomalous;
    // reserve the warning for that and ignore the rest silently. (Warning
    // per message previously emitted tens of thousands of lines per session
    // — dominated by streaming deltas — which buried real errors in the log
    // and pushed it toward the 10 MB rotation cap.)
    if (type.startsWith("host_")) {
      log.warn("[host-proxy-router] unrecognized host proxy message type, ignoring", { type });
    }
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
    case "host_ui_snapshot":
      void poster.postUiSnapshotResult({
        requestId,
        isError: true,
        errorMessage: "Executor not yet implemented",
      });
      break;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle — connect / disconnect per assistant
// ---------------------------------------------------------------------------

/**
 * Exchange a guardian access token for a gateway JWT via POST /auth/token.
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

async function acquireGuardianToken(
  assistantId: string,
  options?: GuardianTokenOptions,
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

  // Pin the environment the guardian-token CLI subprocess (refresh) sees to
  // the same one `configDir` is resolved from, so the token is always read
  // and written under the same env dir.
  const tokenResult = await getGuardianAccessToken(
    assistantId,
    configDir,
    invocation,
    true,
    { VELLUM_ENVIRONMENT: resolveEnvironmentName(process.env) },
    options,
  );

  if (!tokenResult.ok) {
    log.warn("[host-proxy-router] failed to obtain guardian token", {
      assistantId,
      error: tokenResult.error,
    });
    return null;
  }

  return tokenResult.accessToken;
}

async function acquireGatewayToken(
  assistantId: string,
  gatewayPort: number,
): Promise<string | null> {
  const guardianToken = await acquireGuardianToken(assistantId);
  if (!guardianToken) return null;

  const exchanged = await exchangeForGatewayToken(gatewayPort, guardianToken);
  if (!exchanged) return null;

  return exchanged.token;
}

// A connection's fingerprint encodes everything that, if changed, requires a
// reconnect. Single-sourced here so the value set on connect and the value
// recomputed in `handleLockfileChange` can never drift (a mismatch would loop
// connect/disconnect forever).
const localFingerprint = (gatewayPort: number): string => `local:${gatewayPort}`;
const cloudFingerprint = (runtimeUrl: string, organizationId?: string): string =>
  `cloud:${runtimeUrl}:${organizationId ?? ""}`;
const pairedFingerprint = (runtimeUrl: string, assistantId: string): string =>
  `paired:${runtimeUrl}:${assistantId}`;

// -- Pending-connect guard ---------------------------------------------------

/**
 * Run a connect attempt under the pending-connect guard: register the pending
 * entry synchronously, acquire the token, abort if the reconcile pass cancels
 * or replaces the attempt while the token await is in flight, then open the
 * connection synchronously. Cleans up only its own pending entry.
 */
async function connectWithPendingGuard(
  assistantId: string,
  fingerprint: string,
  acquireToken: () => Promise<string | null>,
  open: (token: string) => void,
): Promise<void> {
  if (connections.has(assistantId)) return;
  if (pendingConnects.get(assistantId)?.fingerprint === fingerprint) return;

  const pending: PendingConnect = { fingerprint };
  pendingConnects.set(assistantId, pending);
  try {
    const token = await acquireToken();
    if (pendingConnects.get(assistantId) !== pending || connections.has(assistantId)) {
      log.info("[host-proxy-router] lockfile changed during token acquisition, aborting stale connect", { assistantId, fingerprint });
      return;
    }
    if (!token) {
      log.warn("[host-proxy-router] could not acquire token, skipping connection", { assistantId, fingerprint });
      return;
    }

    open(token);
  } finally {
    if (pendingConnects.get(assistantId) === pending) pendingConnects.delete(assistantId);
  }
}

// -- Local assistant connection ---------------------------------------------

async function connectLocalAssistant(
  assistantId: string,
  gatewayPort: number,
): Promise<void> {
  const fingerprint = localFingerprint(gatewayPort);
  await connectWithPendingGuard(
    assistantId,
    fingerprint,
    () => acquireGatewayToken(assistantId, gatewayPort),
    (token) => openLocalConnection(assistantId, gatewayPort, token, fingerprint),
  );
}

function openLocalConnection(
  assistantId: string,
  gatewayPort: number,
  gatewayToken: string,
  fingerprint: string,
): void {
  let currentToken = gatewayToken;
  const authHeaders = () => ({ Authorization: `Bearer ${currentToken}` });

  const onRefreshToken = async (): Promise<string | null> => {
    const fresh = await acquireGatewayToken(assistantId, gatewayPort);
    if (fresh) currentToken = fresh;
    return fresh;
  };

  const eventsUrl = `http://127.0.0.1:${gatewayPort}/v1/events`;
  const endpointBase = `http://127.0.0.1:${gatewayPort}/v1`;

  const sse = new HostProxySseClient({ eventsUrl, authHeaders, onRefreshToken });
  const poster = new HostProxyPoster({ endpointBase, authHeaders, refreshAuth: onRefreshToken });

  sse.setMessageCallback((msg) => dispatchMessage(msg, poster));
  sse.connect();

  connections.set(assistantId, { sse, poster, fingerprint });
  log.info("[host-proxy-router] connected to local assistant", { assistantId, gatewayPort });
}

// -- Paired assistant connection --------------------------------------------

async function connectPairedAssistant(
  assistantId: string,
  runtimeUrl: string,
): Promise<void> {
  const fingerprint = pairedFingerprint(runtimeUrl, assistantId);
  await connectWithPendingGuard(
    assistantId,
    fingerprint,
    () => acquireGuardianToken(assistantId, { paired: true }),
    (token) => openPairedConnection(assistantId, runtimeUrl, token, fingerprint),
  );
}

function openPairedConnection(
  assistantId: string,
  runtimeUrl: string,
  guardianToken: string,
  fingerprint: string,
): void {
  let currentToken = guardianToken;
  // The guardian access token is the bearer on the remote hop; the
  // /auth/token exchange is loopback-only and never runs for paired entries.
  // Paired runtimeUrls are commonly ngrok tunnels; free-tier edges intercept
  // requests lacking the skip header with an interstitial page.
  const authHeaders = () => ({
    Authorization: `Bearer ${currentToken}`,
    "ngrok-skip-browser-warning": "true",
  });

  const onRefreshToken = async (): Promise<string | null> => {
    const fresh = await acquireGuardianToken(assistantId, { paired: true });
    if (fresh) currentToken = fresh;
    return fresh;
  };

  const base = runtimeUrl.replace(/\/+$/, "");
  const eventsUrl = `${base}/v1/events`;
  const endpointBase = `${base}/v1`;

  const sse = new HostProxySseClient({ eventsUrl, authHeaders, onRefreshToken });
  const poster = new HostProxyPoster({ endpointBase, authHeaders, refreshAuth: onRefreshToken });

  sse.setMessageCallback((msg) => dispatchMessage(msg, poster));
  sse.connect();

  connections.set(assistantId, { sse, poster, fingerprint });
  log.info("[host-proxy-router] connected to paired assistant", { assistantId, runtimeUrl });
}

// -- Cloud assistant connection ---------------------------------------------

function connectCloudAssistant(
  assistantId: string,
  runtimeUrl: string,
  organizationId?: string,
): void {
  if (connections.has(assistantId)) return;

  const sessionToken = getSessionToken();
  if (!sessionToken) {
    log.warn("[host-proxy-router] no session token, skipping cloud connection", { assistantId });
    return;
  }

  const baseUrl = runtimeUrl.replace(/\/$/, "");

  const authHeaders = (): Record<string, string> => {
    const token = getSessionToken();
    if (!token) return {};
    const headers: Record<string, string> = { "X-Session-Token": token };
    if (organizationId) headers["Vellum-Organization-Id"] = organizationId;
    return headers;
  };

  const eventsUrl = `${baseUrl}/v1/assistants/${encodeURIComponent(assistantId)}/events`;
  const endpointBase = `${baseUrl}/v1/assistants/${encodeURIComponent(assistantId)}`;

  const sse = new HostProxySseClient({ eventsUrl, authHeaders });
  const poster = new HostProxyPoster({ endpointBase, authHeaders });

  sse.setMessageCallback((msg) => dispatchMessage(msg, poster));
  sse.connect();

  connections.set(assistantId, {
    sse,
    poster,
    fingerprint: cloudFingerprint(runtimeUrl, organizationId),
  });
  log.info("[host-proxy-router] connected to cloud assistant", { assistantId, runtimeUrl, organizationId });
}

// -- Disconnect -------------------------------------------------------------

function disconnectAssistant(assistantId: string): void {
  if (pendingConnects.delete(assistantId)) {
    log.info("[host-proxy-router] cancelled pending connection", { assistantId });
  }
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
    // Cloud wins over resources: a merge can leave a stale gatewayPort on a
    // non-loopback entry (paired, vellum), and such an entry must never be
    // classified as a loopback connection.
    const port = isLoopbackGatewayCloud(assistant.cloud)
      ? assistant.resources?.gatewayPort
      : undefined;
    const isCloud = assistant.cloud === "vellum" && assistant.runtimeUrl;
    const isPaired =
      assistant.cloud === "paired" && isUsableRuntimeUrl(assistant.runtimeUrl);
    if (!port && !isCloud && !isPaired) continue;

    activeIds.add(assistant.assistantId);
    const fp = port
      ? localFingerprint(port)
      : isPaired
        ? pairedFingerprint(assistant.runtimeUrl!, assistant.assistantId)
        : cloudFingerprint(assistant.runtimeUrl!, assistant.organizationId);

    const existing = connections.get(assistant.assistantId);
    const pending = pendingConnects.get(assistant.assistantId);
    if ((existing && existing.fingerprint !== fp) || (pending && pending.fingerprint !== fp)) {
      log.info("[host-proxy-router] connection config changed, reconnecting", {
        assistantId: assistant.assistantId,
        oldFingerprint: existing?.fingerprint ?? pending?.fingerprint,
        newFingerprint: fp,
      });
      disconnectAssistant(assistant.assistantId);
    }
    if (!connections.has(assistant.assistantId)) {
      if (port) {
        void connectLocalAssistant(assistant.assistantId, port);
      } else if (isPaired) {
        void connectPairedAssistant(assistant.assistantId, assistant.runtimeUrl!);
      } else {
        connectCloudAssistant(
          assistant.assistantId,
          assistant.runtimeUrl!,
          assistant.organizationId,
        );
      }
    }
  }

  // Disconnect assistants (including in-flight connects) no longer in the lockfile
  for (const assistantId of new Set([...connections.keys(), ...pendingConnects.keys()])) {
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
  setExecutor("host_cu", hostCuExecutor);
  setExecutor("host_app_control", hostAppControlExecutor);
  setExecutor("host_ui_snapshot", hostUiSnapshotExecutor);
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
    for (const assistantId of new Set([...connections.keys(), ...pendingConnects.keys()])) {
      disconnectAssistant(assistantId);
    }
    browserExecutor.destroy();
    removeExecutor("host_browser");
    removeExecutor("host_cu");
    removeExecutor("host_app_control");
    shutdownSharedCuHelper();
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
  get pendingConnects() {
    return pendingConnects;
  },
  get executors() {
    return executors;
  },
  dispatchMessage,
  connectLocalAssistant,
  connectCloudAssistant,
  connectPairedAssistant,
  disconnectAssistant,
  handleLockfileChange,
  reset() {
    for (const assistantId of new Set([...connections.keys(), ...pendingConnects.keys()])) {
      disconnectAssistant(assistantId);
    }
    executors.clear();
    resolveCliInvocation = null;
    unsubscribe?.();
    unsubscribe = null;
  },
};
