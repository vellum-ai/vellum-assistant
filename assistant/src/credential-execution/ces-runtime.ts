import type { CesClient } from "./client.js";
import type { CesProcessManager } from "./process-manager.js";

/**
 * Process-level singleton holding the daemon's live CES (Credential Execution
 * Service) connection. The startup flow is driven by `startCesProcess()` in
 * lifecycle.ts, which hands the result here via `setCes()`; shutdown tears it
 * down via `stopCes()`.
 */

let processManager: CesProcessManager | undefined;
let clientPromise: Promise<CesClient | undefined> | undefined;
let initAbortController: AbortController | undefined;
let clientRef: CesClient | undefined;
/** Monotonically increasing counter to detect stale client updates. */
let clientGeneration = 0;

/**
 * Inject the CES client and process manager produced during startup. Must be
 * called before any consumer reads the client via `getCesClient()`.
 */
export function setCes(result: {
  client: CesClient | undefined;
  processManager: CesProcessManager | undefined;
  clientPromise: Promise<CesClient | undefined> | undefined;
  abortController: AbortController | undefined;
}): void {
  clientRef = result.client;
  processManager = result.processManager;
  initAbortController = result.abortController;

  // Wrap the external promise so that clientRef stays in sync once the
  // handshake completes — the async work runs in lifecycle.ts but consumers
  // need the resolved client reference for getCesClient(). Use a generation
  // snapshot so a late-resolving promise doesn't overwrite a newer client set
  // by updateCesClient().
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
 * Return the CES client reference (if available). Used by routes that need to
 * push updates to CES (e.g. secret-routes).
 */
export function getCesClient(): CesClient | undefined {
  return clientRef;
}

/**
 * Update the CES client reference after a successful reconnection. Called via
 * the `onCesClientChanged` listener registered in lifecycle.ts. Bumps the
 * generation counter so any pending setCes() promise callback won't overwrite
 * this newer client.
 */
export function updateCesClient(client: CesClient | undefined): void {
  clientGeneration++;
  clientRef = client;
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
