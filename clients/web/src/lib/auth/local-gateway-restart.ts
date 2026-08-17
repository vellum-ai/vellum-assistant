let restartOperationsInFlight = 0;
const requestsStartedDuringRestart = new WeakSet<Request>();

/** Starts a restart scope and returns an idempotent release callback. */
export function beginLocalGatewayRestart(): () => void {
  restartOperationsInFlight += 1;
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    restartOperationsInFlight = Math.max(0, restartOperationsInFlight - 1);
  };
}

/** Whether a user-initiated local gateway restart is still reconnecting. */
export function isLocalGatewayRestartInProgress(): boolean {
  return restartOperationsInFlight > 0;
}

/** Associates a request with the restart scope active when it was sent. */
export function markLocalGatewayRestartRequest(request: Request): Request {
  if (isLocalGatewayRestartInProgress()) {
    requestsStartedDuringRestart.add(request);
  }
  return request;
}

/** Whether the request was sent while an explicit restart was active. */
export function wasLocalGatewayRestartRequest(request?: Request): boolean {
  return request != null && requestsStartedDuringRestart.has(request);
}
