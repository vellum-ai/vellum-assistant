/**
 * Origin-mode derivation for vbundle exports.
 *
 * The vbundle manifest v1 schema's `origin.mode` enum captures the deployment
 * shape that produced the bundle. The runtime's two underlying signals are:
 *
 *   - `getIsPlatform()` — true when the daemon runs as a platform-managed
 *     deployment (`IS_PLATFORM`, set only on platform pods).
 *   - `getIsContainerized()` — true when the daemon runs inside a container
 *     (`IS_CONTAINERIZED`), identifying where the daemon process is running.
 *
 * Deliberately NOT keyed on managed-proxy prerequisites: since the
 * managed-on-login work, any logged-in local assistant holds a platform URL
 * and `assistant_api_key` (to use the platform LLM proxy), so proxy-prereq
 * presence no longer distinguishes a managed deployment from a local one.
 * Stamping a local export as "managed" trips the importer's
 * `secrets_redacted must be true when origin.mode is 'managed'` rule and
 * breaks local→platform teleport for every logged-in local assistant.
 */

import {
  getIsContainerized,
  getIsPlatform,
} from "../../config/env-registry.js";

export type VBundleOriginMode =
  | "managed"
  | "self-hosted-remote"
  | "self-hosted-local";

/**
 * Returns the origin mode for the current daemon.
 *
 * Platform-managed deployments win first; otherwise containerized →
 * "self-hosted-remote", bare-metal → "self-hosted-local".
 */
export async function getOriginMode(): Promise<VBundleOriginMode> {
  if (getIsPlatform()) {
    return "managed";
  }
  if (getIsContainerized()) {
    return "self-hosted-remote";
  }
  return "self-hosted-local";
}
