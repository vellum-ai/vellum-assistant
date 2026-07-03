// Module-level readiness state for the daemon, readable synchronously from any
// request handler with no `await`. The `/readyz` probe gates on these latches
// to report whether the daemon can actually serve requests.
//
// CES is intentionally not latched here: it is read live
// (`getCesClient()?.isReady()`) only when reported in a response body, and must
// never gate readiness.

let dbReady = false;
let startupComplete = false;

export function setDbReady(v: boolean): void {
  dbReady = v;
}

export function isDbReady(): boolean {
  return dbReady;
}

// One-way latch: once startup completes it stays complete for the process
// lifetime.
export function setStartupComplete(): void {
  startupComplete = true;
}

export function isStartupComplete(): boolean {
  return startupComplete;
}

export function resetReadinessForTest(): void {
  dbReady = false;
  startupComplete = false;
}
