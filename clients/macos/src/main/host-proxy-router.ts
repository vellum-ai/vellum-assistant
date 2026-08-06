/**
 * Host proxy message router and daemon connection lifecycle.
 *
 * Listens for lockfile changes and maintains an SSE + poster pair for each
 * assistant. Local assistants (with a gatewayPort) connect to the loopback
 * gateway; cloud/managed assistants connect to the platform via
 * assistant-scoped URLs with session-token auth. Paired assistants use the
 * desktop data plane without receiving access to this Mac's host tools.
 *
 * Incoming SSE messages are dispatched to pluggable executors; unimplemented
 * executors post error results so daemon requests don't hang.
 */

import {
  getGuardianAccessToken,
  resolveConfigDir,
  resolveEnvironmentName,
  type CliInvocation,
} from "@vellumai/local-mode";
import {
  isLoopbackGatewayCloud,
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
import { installPresenceMonitor, type PresenceState } from "./presence";
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
  /**
   * Set while presence posts to this assistant are failing, so an outage is
   * logged once rather than once per poll. Per connection on purpose: a
   * reconnect is a new route to the daemon, and one line saying it is still
   * broken is worth more than silence.
   */
  presencePostFailing?: boolean;
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
// Presence reporting
// ---------------------------------------------------------------------------

/**
 * Most recent state seen from the presence monitor, used to seed an assistant
 * that connects between poll ticks. Null until the first report: with no
 * presence record on file the daemon lets the mobile push through, so sending
 * nothing is the fail-open direction and a guessed state would be worse.
 */
let lastPresenceState: PresenceState | null = null;

interface PresenceQueue {
  /**
   * State reported while the post was in flight, sent once that post settles.
   * Only the newest is kept: a state the user has already left is never worth
   * a request of its own.
   */
  pending?: PresenceState;
}

/**
 * Presence posts in flight, keyed by assistantId. An entry lives for exactly
 * as long as a drain is running, so having one is the in-flight latch.
 *
 * Keyed by assistant rather than held on the connection because a reconnect
 * (an organizationId change, lockfile churn) builds a fresh connection while
 * the old one's post is still out, and nothing aborts that post. Both carry
 * the same client id, so the daemon files them under one record: a latch that
 * started over per connection would let a stale `active` land after a newer
 * `away` and suppress the mobile push for the length of the staleness window.
 */
const presencePostQueues = new Map<string, PresenceQueue>();

/**
 * The state each daemon has confirmed it wrote down, keyed by assistantId.
 *
 * Whether a report is news is a question about one daemon, not about the
 * desktop: the same report can be recorded by one assistant and lost by
 * another. Set only when a post comes back recorded, so a timeout, a non-2xx,
 * a throw, or a reply saying the report was accepted but not recorded all
 * leave the previous entry standing and the next report tries again.
 */
const lastRecordedState = new Map<string, PresenceState>();

/**
 * Whether this report is worth a request to this assistant.
 *
 * `active` always is. It is the only state that suppresses a push, the daemon
 * expires the record after a staleness bound, and a keep-alive that skipped a
 * tick would let pushes resume while the user is sitting at the desk.
 *
 * A repeat of a non-active state the daemon has confirmed is not: an expired
 * record and a repeated `idle`/`away` mean the same thing downstream (not
 * attended, push sent). Skipping only on a confirmed state is also what keeps
 * this fail-open, since an entry here can only be non-active when the last
 * recorded post was that state, so the daemon cannot be holding an `active`
 * this silence would preserve.
 *
 * A post in flight bars the skip outright: the record is about to become
 * whatever that post carries, so what was confirmed before it says nothing
 * about what the daemon will hold once it lands.
 */
function shouldPostPresence(assistantId: string, state: PresenceState): boolean {
  if (state === "active") {
    return true;
  }
  if (presencePostQueues.has(assistantId)) {
    return true;
  }
  return lastRecordedState.get(assistantId) !== state;
}

/**
 * Post one report, logging only the first failure of a run.
 *
 * postPresence folds every non-2xx, every throw, and every reply that says the
 * report was accepted but not recorded into `false`, so a daemon that stops
 * recording reports would otherwise take presence down in total silence.
 * Warning on each attempt instead would put a line in the log every poll
 * interval for the length of the outage, so the connection stays quiet until a
 * post succeeds and re-arms the warning.
 */
async function postPresenceTo(
  assistantId: string,
  conn: AssistantConnection,
  state: PresenceState,
): Promise<void> {
  // The daemon attributes a report to the client behind its live SSE stream,
  // so a report sent while the stream is down is discarded anyway. Skipping is
  // also the fail-open direction: with no presence record the push goes out.
  if (!conn.sse.isConnected) {
    return;
  }

  let posted = false;
  try {
    posted = await conn.poster.postPresence({ state });
  } catch {
    posted = false;
  }
  if (posted) {
    conn.presencePostFailing = false;
    lastRecordedState.set(assistantId, state);
    return;
  }
  if (!conn.presencePostFailing) {
    conn.presencePostFailing = true;
    log.warn("[host-proxy-router] presence post failed", { assistantId, state });
  }
}

/**
 * Run one assistant's presence posts one at a time until no newer state is
 * waiting, so the daemon's last write is always the newest state the desktop
 * has observed.
 *
 * Concurrent posts have no ordering guarantee, and a stale `active` landing
 * after an `away` would leave the daemon holding "attended" (with a fresh
 * timestamp) for a Mac the user has walked away from, suppressing the mobile
 * push. That is the one outcome presence must never produce, so a report that
 * arrives mid-flight waits its turn instead of racing.
 *
 * The connection is re-read each pass instead of captured, so a state queued
 * before a reconnect goes out over whichever connection is live when its turn
 * comes. An assistant with no connection ends the drain: with no stream to
 * attribute a report to, saying nothing is the fail-open direction.
 *
 * Only the newest waiting state is sent: intermediate states have already been
 * superseded, and the daemon only ever reads the latest record. A follow-up
 * that matches what just went out is dropped for the same reason. Nothing
 * throws out of here, since the caller can only fire and forget.
 */
async function drainPresencePosts(
  assistantId: string,
  queue: PresenceQueue,
  first: PresenceState,
): Promise<void> {
  let next: PresenceState | undefined = first;
  try {
    while (next !== undefined) {
      const conn = connections.get(assistantId);
      if (!conn) {
        return;
      }
      const posting: PresenceState = next;
      queue.pending = undefined;
      await postPresenceTo(assistantId, conn, posting);
      const pending = queue.pending;
      next = pending === posting ? undefined : pending;
    }
  } catch (err) {
    log.warn("[host-proxy-router] presence post loop failed", { assistantId, err });
  } finally {
    queue.pending = undefined;
    // Only if this drain still owns the latch: an assistant that went away and
    // came back mid-drain has a queue of its own that must not be dropped.
    if (presencePostQueues.get(assistantId) === queue) {
      presencePostQueues.delete(assistantId);
    }
  }
}

/**
 * Send a report to one assistant, holding it back if that assistant already
 * has a post in flight. State is per assistant, so a slow daemon delays only
 * its own reports.
 *
 * Unconditional, so callers that must reach a daemon whatever it last
 * confirmed (the connect-time seed) go straight here. `shouldPostPresence`
 * runs ahead of it rather than inside it, so a report that will not be sent
 * neither opens a queue nor overwrites a state genuinely waiting in one.
 */
function queuePresencePost(assistantId: string, state: PresenceState): void {
  const inFlight = presencePostQueues.get(assistantId);
  if (inFlight) {
    inFlight.pending = state;
    return;
  }
  const queue: PresenceQueue = {};
  presencePostQueues.set(assistantId, queue);
  void drainPresencePosts(assistantId, queue, state);
}

/**
 * Fan a presence report out to every connected assistant: the lockfile can
 * hold several (local and cloud) and the desktop is equally attended for all
 * of them.
 *
 * Posting is fire-and-forget (postJson carries its own timeout) so a slow or
 * unreachable daemon can't stall the reporter or its siblings. A dropped
 * report is the safe direction: with no presence record on file the daemon
 * lets the mobile push through.
 */
function reportPresence(state: PresenceState): void {
  lastPresenceState = state;
  for (const assistantId of connections.keys()) {
    if (shouldPostPresence(assistantId, state)) {
      queuePresencePost(assistantId, state);
    }
  }
}

/**
 * Report to an assistant the moment its SSE stream goes live. A monitor report
 * only reaches whoever is connected when it fires, so without this a stream
 * that comes up between poll ticks would go unreported until the next one.
 *
 * Keyed to the stream rather than to the connection being created, because the
 * daemon can only attribute a report once it has this client's subscriber. The
 * same reason makes it fire on reconnects: the daemon dropped the subscriber
 * and its presence record with it.
 *
 * Goes through the same queue as a poll tick, so a seed landing next to one
 * cannot reinstate the state the other has already superseded, but not through
 * the confirmed-state skip: the stream this rides went down and took the
 * daemon's record with it, so what that daemon last confirmed says nothing
 * about what it holds now.
 */
function seedPresence(assistantId: string): void {
  if (lastPresenceState === null) {
    return;
  }
  if (!connections.has(assistantId)) {
    return;
  }
  queuePresencePost(assistantId, lastPresenceState);
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

  const sse = new HostProxySseClient({
    eventsUrl,
    authHeaders,
    onRefreshToken,
    onConnected: () => seedPresence(assistantId),
  });
  const poster = new HostProxyPoster({ endpointBase, authHeaders, refreshAuth: onRefreshToken });

  sse.setMessageCallback((msg) => dispatchMessage(msg, poster));

  // Registered before the stream opens so the onConnected seed can find it.
  connections.set(assistantId, { sse, poster, fingerprint });
  sse.connect();
  log.info("[host-proxy-router] connected to local assistant", { assistantId, gatewayPort });
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

  const sse = new HostProxySseClient({
    eventsUrl,
    authHeaders,
    onConnected: () => seedPresence(assistantId),
  });
  const poster = new HostProxyPoster({ endpointBase, authHeaders });

  sse.setMessageCallback((msg) => dispatchMessage(msg, poster));

  // Registered before the stream opens so the onConnected seed can find it.
  connections.set(assistantId, {
    sse,
    poster,
    fingerprint: cloudFingerprint(runtimeUrl, organizationId),
  });
  sse.connect();
  log.info("[host-proxy-router] connected to cloud assistant", { assistantId, runtimeUrl, organizationId });
}

// -- Disconnect -------------------------------------------------------------

// Deliberately leaves the assistant's presence queue and recorded state in
// place: a reconnect runs through here, nothing aborts the post the old
// connection has out, and a fresh latch is what lets that stale post land
// last. The recorded state can only name a non-active state and the fresh
// stream seeds itself, so it costs nothing to keep. Callers that know the
// assistant is gone for good clear both.
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
    // non-loopback entry, and such an entry must never be classified as a
    // loopback connection. Paired entries intentionally match neither branch.
    const port = isLoopbackGatewayCloud(assistant.cloud)
      ? assistant.resources?.gatewayPort
      : undefined;
    const isCloud = assistant.cloud === "vellum" && assistant.runtimeUrl;
    if (!port && !isCloud) continue;

    activeIds.add(assistant.assistantId);
    const fp = port
      ? localFingerprint(port)
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
      // Gone rather than reconnecting, so nothing is left to serve the queue
      // and nothing survives that could still be holding the recorded state.
      presencePostQueues.delete(assistantId);
      lastRecordedState.delete(assistantId);
    }
  }
}

// ---------------------------------------------------------------------------
// Public install / teardown
// ---------------------------------------------------------------------------

let unsubscribe: (() => void) | null = null;
let stopPresenceMonitor: (() => void) | null = null;

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

  // Not gated on there being any connections: the monitor is cheap, its
  // first report primes the cache, and a connection added later by
  // handleLockfileChange is seeded as it joins. Stopping any previous
  // monitor first keeps a second install from leaking its interval and
  // powerMonitor listeners.
  stopPresenceMonitor?.();
  // Guarded because this install runs inside `app.whenReady()` ahead of the
  // tray, native auth, and the main window, so a throw escaping here would
  // take the rest of app startup with it. Presence is an optional
  // optimization and losing it lets the mobile push through, which is the
  // safe direction; losing the app is not. Left null so teardown no-ops.
  stopPresenceMonitor = null;
  try {
    stopPresenceMonitor = installPresenceMonitor(reportPresence);
  } catch (err) {
    log.warn("[host-proxy-router] presence monitor install failed", { err });
  }

  return () => {
    stopPresenceMonitor?.();
    stopPresenceMonitor = null;
    lastPresenceState = null;
    unsubscribe?.();
    unsubscribe = null;
    for (const assistantId of new Set([...connections.keys(), ...pendingConnects.keys()])) {
      disconnectAssistant(assistantId);
    }
    presencePostQueues.clear();
    lastRecordedState.clear();
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
  get presencePostQueues() {
    return presencePostQueues;
  },
  get lastRecordedState() {
    return lastRecordedState;
  },
  dispatchMessage,
  connectLocalAssistant,
  connectCloudAssistant,
  disconnectAssistant,
  handleLockfileChange,
  seedPresence,
  reset() {
    stopPresenceMonitor?.();
    stopPresenceMonitor = null;
    lastPresenceState = null;
    for (const assistantId of new Set([...connections.keys(), ...pendingConnects.keys()])) {
      disconnectAssistant(assistantId);
    }
    presencePostQueues.clear();
    lastRecordedState.clear();
    executors.clear();
    resolveCliInvocation = null;
    unsubscribe?.();
    unsubscribe = null;
  },
};
