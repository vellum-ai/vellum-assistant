import type { CesClient } from "./client.js";

export interface AwaitCesClientWithTimeoutOptions {
  timeoutMs?: number;
  onTimeout?: () => void;
}

export const DEFAULT_CES_STARTUP_TIMEOUT_MS = 20_000;

export async function awaitCesClientWithTimeout(
  clientPromise: Promise<CesClient | undefined>,
  options: AwaitCesClientWithTimeoutOptions = {},
): Promise<CesClient | undefined> {
  const { timeoutMs = DEFAULT_CES_STARTUP_TIMEOUT_MS, onTimeout = () => {} } =
    options;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      clientPromise,
      new Promise<undefined>((resolve) => {
        timeoutId = setTimeout(() => {
          onTimeout();
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export interface CesClientResolver {
  getCesClient: () => CesClient | undefined;
  setCesClient: (client: CesClient) => void;
}

/**
 * Inject the CES client into the credential resolver once the startup
 * handshake resolves.
 *
 * {@link awaitCesClientWithTimeout} only gates provider initialization: when
 * the handshake loses the race it returns before the client exists, so the
 * caller cannot inject it synchronously. This bridges that gap by injecting
 * the client whenever the handshake eventually completes. The resolver is left
 * untouched if it already holds a client (e.g. one installed by a reconnection
 * while the late handshake was still in flight) so the older startup client
 * never clobbers a newer one, and a failed or aborted handshake is a no-op.
 */
export function injectCesClientWhenReady(
  clientPromise: Promise<CesClient | undefined>,
  resolver: CesClientResolver,
): void {
  void clientPromise
    .then((client) => {
      if (client && resolver.getCesClient() === undefined) {
        resolver.setCesClient(client);
      }
    })
    .catch(() => undefined);
}
