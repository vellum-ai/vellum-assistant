/**
 * Runtime readiness flag: reflects that critical startup is complete
 * (HTTP server bound + DB initialized + daemon server started). Read by
 * `handleReadyz()` to gate the K8s readinessProbe (`/readyz`). Kept
 * dependency-free so both `lifecycle.ts` and `identity-routes.ts` can
 * import it without creating a module cycle.
 */

let runtimeReady = false;

export function setRuntimeReady(): void {
  runtimeReady = true;
}

export function isRuntimeReady(): boolean {
  return runtimeReady;
}
