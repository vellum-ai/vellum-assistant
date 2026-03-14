/**
 * Shared fixtures for media-reuse testing.
 *
 * Provides deterministic attachment blobs and approval response helpers
 * used by the proxy and asset tool test suites.
 */

import type { StoredAttachment } from "../../memory/attachments-store.js";
import type { UserDecision } from "../../permissions/types.js";

// ---------------------------------------------------------------------------
// Fake attachment data
// ---------------------------------------------------------------------------

/** A tiny 1x1 red PNG pixel, base64-encoded. */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

// ---------------------------------------------------------------------------
// Deterministic attachment records
// ---------------------------------------------------------------------------

const NOW = 1700000000000;

/** A fake selfie image attachment with deterministic IDs. */
export const FAKE_SELFIE_ATTACHMENT: StoredAttachment = {
  id: "att-selfie-001",
  originalFilename: "selfie.png",
  mimeType: "image/png",
  sizeBytes: Buffer.from(TINY_PNG_BASE64, "base64").length,
  kind: "image",
  thumbnailBase64: null,
  createdAt: NOW,
};

// ---------------------------------------------------------------------------
// Approval response helpers
// ---------------------------------------------------------------------------

interface FakeApprovalResponse {
  decision: UserDecision;
  /** Pattern for "always allow" decisions (undefined for one-shot allow/deny). */
  pattern?: string;
  /** Scope prefix for trust rule creation. */
  scope?: string;
}

/** Returns a one-shot allow decision. */
export function fakeAllowOnce(): FakeApprovalResponse {
  return { decision: "allow" };
}

/** Returns a deny decision. */
export function fakeDeny(): FakeApprovalResponse {
  return { decision: "deny" };
}
