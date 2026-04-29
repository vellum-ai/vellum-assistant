/**
 * Origin-mode derivation for vbundle exports.
 *
 * The vbundle manifest v1 schema's `origin.mode` enum captures the deployment
 * shape that produced the bundle. The runtime's two underlying signals are:
 *
 *   - `hasManagedProxyPrereqs()` — true when the daemon has the credentials
 *     it needs to act as a managed-proxy client, i.e. this is a managed
 *     deployment.
 *   - `getDaemonRuntimeMode()` — `"docker"` vs `"bare-metal"`, identifying
 *     where the daemon process is running.
 *
 * Folding both into a single helper keeps callers from repeating the
 * combination logic.
 */

import { hasManagedProxyPrereqs } from "../../providers/managed-proxy/context.js";
import { getDaemonRuntimeMode } from "../runtime-mode.js";

export type VBundleOriginMode =
  | "managed"
  | "self-hosted-remote"
  | "self-hosted-local";

/**
 * Returns the origin mode for the current daemon.
 *
 * Managed-proxy prereqs win first (a managed deployment is always
 * "managed" regardless of where the daemon process runs); otherwise docker
 * → "self-hosted-remote", bare-metal → "self-hosted-local".
 */
export async function getOriginMode(): Promise<VBundleOriginMode> {
  if (await hasManagedProxyPrereqs()) {
    return "managed";
  }
  if (getDaemonRuntimeMode() === "docker") {
    return "self-hosted-remote";
  }
  return "self-hosted-local";
}
