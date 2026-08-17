let restartOperationsInFlight = 0;

/**
 * Runs a user-initiated local gateway restart while auth recovery treats
 * gateway 401 responses as transient. The caller must reacquire a gateway
 * token before the operation resolves.
 */
export async function withLocalGatewayRestart<T>(
  operation: () => Promise<T>,
): Promise<T> {
  restartOperationsInFlight += 1;
  try {
    return await operation();
  } finally {
    restartOperationsInFlight = Math.max(0, restartOperationsInFlight - 1);
  }
}

/** Whether a user-initiated local gateway restart is still reconnecting. */
export function isLocalGatewayRestartInProgress(): boolean {
  return restartOperationsInFlight > 0;
}
