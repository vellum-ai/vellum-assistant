/**
 * Shared fixtures for media-reuse testing.
 *
 * Provides deterministic attachment blobs, message links, and approval
 * response helpers used by the proxy and asset tool test suites.
 */

import type { StoredAttachment } from '../../memory/attachments-store.js';
import type { UserDecision } from '../../permissions/types.js';

// ---------------------------------------------------------------------------
// Fake attachment data
// ---------------------------------------------------------------------------

/** A tiny 1x1 red PNG pixel, base64-encoded. */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

/** A tiny 1x1 JPEG pixel, base64-encoded. */
export const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMCwsKCwsM' +
  'CgwMDQwMCwwMDQsLCwwODQoMEAwMEQ4ODwwLDgz/2wBDAQMEBAUEBQkFBQkMCwkLDAwMDAwMDAwMDAwM' +
  'DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAz/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

// ---------------------------------------------------------------------------
// Deterministic attachment records
// ---------------------------------------------------------------------------

const NOW = 1700000000000;

/** A fake selfie image attachment with deterministic IDs. */
export const FAKE_SELFIE_ATTACHMENT: StoredAttachment = {
  id: 'att-selfie-001',
  originalFilename: 'selfie.png',
  mimeType: 'image/png',
  sizeBytes: Buffer.from(TINY_PNG_BASE64, 'base64').length,
  kind: 'image',
  thumbnailBase64: null,
  storageKind: 'inline_base64',
  filePath: null,
  sha256: null,
  expiresAt: null,
  createdAt: NOW,
};

/** A fake document attachment. */
export const FAKE_DOCUMENT_ATTACHMENT: StoredAttachment = {
  id: 'att-doc-001',
  originalFilename: 'report.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 4096,
  kind: 'document',
  thumbnailBase64: null,
  storageKind: 'inline_base64',
  filePath: null,
  sha256: null,
  expiresAt: null,
  createdAt: NOW,
};

/** A fake JPEG photo attachment. */
export const FAKE_PHOTO_ATTACHMENT: StoredAttachment = {
  id: 'att-photo-001',
  originalFilename: 'photo.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: Buffer.from(TINY_JPEG_BASE64, 'base64').length,
  kind: 'image',
  thumbnailBase64: null,
  storageKind: 'inline_base64',
  filePath: null,
  sha256: null,
  expiresAt: null,
  createdAt: NOW,
};

// ---------------------------------------------------------------------------
// Message link helpers
// ---------------------------------------------------------------------------

export interface FakeMessageLink {
  messageId: string;
  attachmentId: string;
  conversationId: string;
  position: number;
}

/** A deterministic message-attachment link for the selfie. */
export const FAKE_SELFIE_LINK: FakeMessageLink = {
  messageId: 'msg-001',
  attachmentId: FAKE_SELFIE_ATTACHMENT.id,
  conversationId: 'conv-001',
  position: 0,
};

/** A second link showing multiple attachments on one message. */
export const FAKE_DOCUMENT_LINK: FakeMessageLink = {
  messageId: 'msg-001',
  attachmentId: FAKE_DOCUMENT_ATTACHMENT.id,
  conversationId: 'conv-001',
  position: 1,
};

// ---------------------------------------------------------------------------
// Approval response helpers
// ---------------------------------------------------------------------------

export interface FakeApprovalResponse {
  decision: UserDecision;
  /** Pattern for "always allow" decisions (undefined for one-shot allow/deny). */
  pattern?: string;
  /** Scope prefix for trust rule creation. */
  scope?: string;
}

/** Returns a one-shot allow decision. */
export function fakeAllowOnce(): FakeApprovalResponse {
  return { decision: 'allow' };
}

/** Returns a deny decision. */
export function fakeDeny(): FakeApprovalResponse {
  return { decision: 'deny' };
}

/** Returns an "always allow" decision with a pattern for the trust rule. */
export function fakeAlwaysAllow(pattern: string, scope = '/tmp/test-project'): FakeApprovalResponse {
  return { decision: 'always_allow', pattern, scope };
}

/** Returns an "always allow high risk" decision. */
export function fakeAlwaysAllowHighRisk(pattern: string, scope = '/tmp/test-project'): FakeApprovalResponse {
  return { decision: 'always_allow_high_risk', pattern, scope };
}

/** Returns an "always deny" decision. */
export function fakeAlwaysDeny(): FakeApprovalResponse {
  return { decision: 'always_deny' };
}
