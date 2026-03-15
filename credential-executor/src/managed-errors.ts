/**
 * Error message constants for managed-mode CES.
 *
 * Extracted into a side-effect-free module so contract tests can import
 * and assert against the exact production strings without pulling in the
 * managed-main.ts entrypoint (which has process-level side effects).
 */

/**
 * Error returned when a local_static credential handle is used in managed
 * mode. The encrypted key store uses PBKDF2 key derivation from user
 * identity (username, homedir), but the assistant container runs as root
 * while CES runs as ces — different derived keys make decryption silently
 * fail. Managed deployments must use platform_oauth handles exclusively.
 */
export const MANAGED_LOCAL_STATIC_REJECTION_ERROR =
  "local_static credential handles are not supported in managed mode. " +
  "Use platform_oauth handles for managed deployments.";
