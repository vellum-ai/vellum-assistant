import { getPlatformAssistantId } from "../config/env.js";
import type { AssistantConfig } from "../config/schema.js";
import { resolveManagedProxyContext } from "../providers/platform-proxy/context.js";
import {
  getCesClient as getSecureKeysCesClient,
  onCesClientChanged,
  setCesClient,
  setCesReconnect,
} from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { type CesClient, createCesClient } from "./client.js";
import {
  type CesProcessManager,
  CesUnavailableError,
  createCesProcessManager,
} from "./process-manager.js";
import {
  awaitCesClientWithTimeout,
  DEFAULT_CES_STARTUP_TIMEOUT_MS,
  injectCesClientWhenReady,
} from "./startup-timeout.js";

const log = getLogger("ces-runtime");

/**
 * Process-level singleton owning the daemon's live CES (Credential Execution
 * Service) connection. `startCes()` performs the full handshake + reconnect
 * wiring at daemon startup; `getCesClient()` exposes the live client to routes;
 * `stopCes()` tears it down at shutdown.
 */

let processManager: CesProcessManager | undefined;
let clientPromise: Promise<CesClient | undefined> | undefined;
let initAbortController: AbortController | undefined;
let clientRef: CesClient | undefined;
/** Monotonically increasing counter to detect stale client updates. */
let clientGeneration = 0;

interface CesStartupResult {
  client: CesClient | undefined;
  processManager: CesProcessManager | undefined;
  clientPromise: Promise<CesClient | undefined> | undefined;
  abortController: AbortController | undefined;
}

/**
 * Start the CES process and perform the RPC handshake. Returns immediately with
 * handles to the in-flight initialization — callers don't need to await this
 * for startup to continue.
 *
 * The managed sidecar accepts exactly one bootstrap connection, so this must be
 * called at the process level (not per-conversation).
 */
function startCesProcess(config: AssistantConfig): CesStartupResult {
  const pm = createCesProcessManager({ assistantConfig: config });
  const abortController = new AbortController();
  let currentClient: CesClient | undefined;

  const handshakePromise = (async (): Promise<CesClient | undefined> => {
    try {
      const transport = await pm.start();
      if (abortController.signal.aborted) {
        throw new Error("CES initialization aborted during shutdown");
      }
      const client = createCesClient(transport);
      currentClient = client;
      // Resolve the assistant API key so CES can use it for platform
      // credential materialisation. In managed mode the key is provisioned
      // after hatch and stored in the credential store — CES can't read
      // the env var, so we pass it via the handshake.
      const proxyCtx = await resolveManagedProxyContext();
      const assistantId = getPlatformAssistantId();
      const { accepted, reason } = await client.handshake({
        ...(proxyCtx.assistantApiKey
          ? { assistantApiKey: proxyCtx.assistantApiKey }
          : {}),
        ...(assistantId ? { assistantId } : {}),
      });
      if (abortController.signal.aborted) {
        client.close();
        throw new Error("CES initialization aborted during shutdown");
      }
      if (accepted) {
        log.info(
          "CES client initialized and handshake accepted (server-level)",
        );
        return client;
      }
      log.warn(
        { reason },
        "CES handshake rejected — CES tools will be unavailable",
      );
      client.close();
      currentClient = undefined;
      await pm.stop();
      return undefined;
    } catch (err) {
      if (err instanceof CesUnavailableError) {
        log.info(
          { reason: err.message },
          "CES is not available — CES tools will be unavailable",
        );
      } else {
        log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "Failed to initialize CES client — CES tools will be unavailable",
        );
      }
      await pm.stop().catch(() => {});
      currentClient = undefined;
      return undefined;
    }
  })();

  return {
    get client() {
      return currentClient;
    },
    processManager: pm,
    clientPromise: handshakePromise,
    abortController,
  };
}

/** Store the startup handles so getCesClient()/stopCes() can reach them. */
function applyCesResult(result: CesStartupResult): void {
  clientRef = result.client;
  processManager = result.processManager;
  initAbortController = result.abortController;

  // Wrap the handshake promise so clientRef stays in sync once it resolves.
  // Use a generation snapshot so a late-resolving promise doesn't overwrite a
  // newer client set by a reconnection.
  if (result.clientPromise) {
    const gen = clientGeneration;
    clientPromise = result.clientPromise.then((client) => {
      if (clientGeneration === gen) {
        clientRef = client;
      }
      return client;
    });
  }
}

/**
 * Update the client reference after a reconnection (fired via the
 * `onCesClientChanged` listener). Bumps the generation counter so any pending
 * handshake-promise callback won't overwrite this newer client.
 */
function updateClientRef(client: CesClient | undefined): void {
  clientGeneration++;
  clientRef = client;
}

/**
 * Bring up the daemon's CES connection: start the process, run the handshake
 * (blocking up to a 20s timeout so credential reads can route through CES
 * before provider init), register the reconnection callback, and keep the live
 * client reference in sync. Non-fatal — on failure the daemon falls back to the
 * direct credential store.
 */
export async function startCes(config: AssistantConfig): Promise<void> {
  const cesResult = startCesProcess(config);

  // The handshake runs inside clientPromise. Await it (with a 20s timeout) so
  // the CES client is available before provider initialization; fall back to
  // the direct credential store on timeout.
  if (cesResult.clientPromise) {
    const client = await awaitCesClientWithTimeout(cesResult.clientPromise, {
      timeoutMs: DEFAULT_CES_STARTUP_TIMEOUT_MS,
      onTimeout: () => {
        log.warn(
          "CES handshake timed out after 20s — falling back to direct credential store",
        );
      },
    });
    if (client) {
      setCesClient(client);
    } else {
      // The handshake lost the startup race, so provider init proceeds on the
      // direct credential store. Still inject the CES client into the resolver
      // once the handshake completes, so CES tools and the approval bridge
      // route through CES rather than reporting it unavailable for the rest of
      // the process.
      injectCesClientWhenReady(cesResult.clientPromise, {
        getCesClient: getSecureKeysCesClient,
        setCesClient,
      });
    }
  }

  // Register CES reconnection callback so the credential layer can re-establish
  // the connection when the transport dies, instead of falling back to the
  // encrypted file store.
  if (cesResult.processManager) {
    const pm = cesResult.processManager;

    // Snapshot the managed-proxy context and assistant ID at CES startup so the
    // reconnect closure below never calls back into `resolveManagedProxyContext()`.
    // That function reads the assistant API key via `getSecureKeyAsync()`, which
    // — once `setCesClient()` has resolved the backend to CES RPC — routes the
    // read through CES itself. During a reconnect the old transport is dead and
    // a new one is being set up by this very closure, so the nested credential
    // read recursively awaits its own in-flight reconnection and deadlocks until
    // `CREDENTIAL_OP_TIMEOUT_MS` (45s) fires. That 45-second stall delays every
    // CES restart and causes dependent credential reads (e.g. Meet's STT
    // provider resolution) to return `undefined` during the window. API key
    // rotation uses the `updateAssistantApiKey` RPC on the live client, not a
    // reconnect, so caching at startup is safe.
    const startupProxyCtx = await resolveManagedProxyContext();
    const startupAssistantId = getPlatformAssistantId();

    setCesReconnect(async () => {
      try {
        await pm.stop();
        const transport = await pm.start();
        const newClient = createCesClient(transport);
        const { accepted, reason } = await newClient.handshake({
          ...(startupProxyCtx.assistantApiKey
            ? { assistantApiKey: startupProxyCtx.assistantApiKey }
            : {}),
          ...(startupAssistantId ? { assistantId: startupAssistantId } : {}),
        });
        if (accepted) {
          log.info("CES reconnection handshake accepted");
          return newClient;
        }
        log.warn({ reason }, "CES reconnection handshake rejected");
        newClient.close();
        await pm.stop().catch(() => {});
        return undefined;
      } catch (err) {
        log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "CES reconnection attempt failed",
        );
        await pm.stop().catch(() => {});
        return undefined;
      }
    });
  }

  applyCesResult(cesResult);

  // Keep the client ref in sync after reconnection so that secret routes and
  // new conversations use the fresh client.
  onCesClientChanged(updateClientRef);
}

/**
 * Return the CES client reference (if available). Used by routes that need to
 * push updates to CES (e.g. secret-routes).
 */
export function getCesClient(): CesClient | undefined {
  return clientRef;
}

/** Tear down the CES connection during daemon shutdown. */
export async function stopCes(): Promise<void> {
  // Abort any in-flight CES initialization so it fails fast instead of
  // blocking shutdown for up to ~15s (socket connect + handshake timeouts).
  if (initAbortController) {
    initAbortController.abort();
    initAbortController = undefined;
  }
  // Force-stop the CES process immediately — forceStop() works even if
  // start() hasn't finished (unlike stop() which is a no-op when !running).
  if (processManager) {
    await processManager.forceStop().catch(() => {});
  }
  // Cancel in-flight handshake/RPC timers by closing the client directly.
  // Without this, the handshake setTimeout (~10s) keeps the init promise
  // pending even after the transport is killed.
  if (clientRef) {
    clientRef.close();
    clientRef = undefined;
  }
  // Now await the init promise (which should settle immediately since we
  // killed the transport and cancelled pending timers above).
  if (clientPromise) {
    await clientPromise.catch(() => undefined);
    clientPromise = undefined;
  }
  processManager = undefined;
}
