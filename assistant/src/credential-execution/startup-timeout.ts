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
  const {
    timeoutMs = DEFAULT_CES_STARTUP_TIMEOUT_MS,
    onTimeout = () => {},
  } = options;

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
