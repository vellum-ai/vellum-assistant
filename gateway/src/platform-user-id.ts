/**
 * Bound platform owner id for managed-mode edge auth.
 *
 * Identity is resolved from platform validate and in-memory last-known
 * values. See {@link readStoredPlatformUserId} in `platform-identity.ts`.
 */

export {
  _resetLastKnownPlatformUserIdForTest,
  readStoredPlatformUserId,
  type StoredPlatformUserId,
} from "./platform-identity.js";
