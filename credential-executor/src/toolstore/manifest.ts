/**
 * Toolstore manifest type definitions.
 *
 * Describes an approved secure command bundle that CES can publish into
 * its private immutable toolstore. Each manifest records:
 *
 * - **sourceUrl**        — The canonical URL the bundle was fetched from.
 * - **expectedDigest**   — SHA-256 hex digest that the downloaded bytes
 *                          must match before publication.
 * - **bundleId**         — Unique identifier for the command bundle
 *                          (e.g. "gh-cli", "aws-cli").
 * - **version**          — Semantic version of the bundle.
 * - **commandProfiles**  — Profile names from the secure command manifest
 *                          that this bundle declares.
 *
 * ## Publishing rules
 *
 * 1. **Only CES can write** — bundles are published into the CES-private
 *    data root, which the assistant process cannot reach.
 * 2. **Immutable once published** — a bundle directory keyed by its digest
 *    is never overwritten. Re-publishing the same digest is a no-op.
 * 3. **Workspace-origin binaries are never publishable** — bundles must
 *    come from a known source URL; arbitrary assistant-provided bytes are
 *    rejected.
 * 4. **Publication does not grant credentials** — writing a bundle into
 *    the toolstore is purely a content operation. Credential-use grants
 *    are managed by a separate subsystem.
 */

import type { SecureCommandManifest } from "../commands/profiles.js";

// ---------------------------------------------------------------------------
// Bundle origin
// ---------------------------------------------------------------------------

/**
 * Describes the provenance of a bundle.
 *
 * `sourceUrl` must be an HTTPS URL. Workspace paths, file:// URLs, and
 * data: URLs are structurally rejected.
 */
export interface BundleOrigin {
  /** HTTPS URL from which the bundle was fetched. */
  sourceUrl: string;
  /** ISO-8601 timestamp of when the bundle was fetched. */
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Toolstore manifest
// ---------------------------------------------------------------------------

/**
 * A toolstore manifest describes a single approved secure command bundle.
 *
 * This is the metadata stored alongside the bundle contents in the
 * content-addressed toolstore directory.
 */
export interface ToolstoreManifest {
  /** SHA-256 hex digest of the bundle contents. Content-address key. */
  digest: string;

  /** Unique identifier for the command bundle. */
  bundleId: string;

  /** Semantic version of the bundle. */
  version: string;

  /** Provenance information — where the bundle came from. */
  origin: BundleOrigin;

  /** Profile names declared in the secure command manifest. */
  declaredProfiles: string[];

  /**
   * The full secure command manifest embedded in the toolstore manifest.
   * Used for runtime validation without needing to re-parse the bundle.
   */
  secureCommandManifest: SecureCommandManifest;

  /** ISO-8601 timestamp of when the bundle was published to the toolstore. */
  publishedAt: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Regex for a valid SHA-256 hex digest. */
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Returns true if the given string is a valid SHA-256 hex digest.
 */
export function isValidSha256Hex(digest: string): boolean {
  return SHA256_HEX_PATTERN.test(digest);
}

/**
 * Schemes that are structurally rejected as bundle source URLs.
 * Only HTTPS sources are accepted.
 */
const REJECTED_URL_SCHEMES = ["file:", "data:", "blob:", "javascript:"];

/**
 * Validate a source URL for bundle origin.
 *
 * Accepted: HTTPS URLs only.
 * Rejected: file://, data://, workspace paths, non-URL strings.
 *
 * Returns an error message if invalid, or null if valid.
 */
export function validateSourceUrl(sourceUrl: string): string | null {
  if (!sourceUrl || sourceUrl.trim().length === 0) {
    return "sourceUrl is required and must be non-empty.";
  }

  // Must be a valid URL
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return `sourceUrl "${sourceUrl}" is not a valid URL. Only HTTPS URLs are accepted.`;
  }

  // Must be HTTPS
  if (parsed.protocol !== "https:") {
    if (REJECTED_URL_SCHEMES.includes(parsed.protocol)) {
      return `sourceUrl scheme "${parsed.protocol}" is not allowed. Only HTTPS URLs are accepted as bundle sources.`;
    }
    return `sourceUrl scheme "${parsed.protocol}" is not allowed. Only HTTPS URLs are accepted.`;
  }

  return null;
}

/**
 * Workspace-origin path patterns that are never publishable as bundle
 * sources. These catch attempts to publish assistant-provided bytes
 * directly from the workspace directory.
 */
const WORKSPACE_PATH_PATTERNS = [
  /^~?\/?\.vellum\//,
  /\/\.vellum\//,
  /\/workspace\//i,
] as const;

/**
 * Returns true if the given path looks like a workspace-origin path
 * that should never be accepted as a bundle source.
 */
export function isWorkspaceOriginPath(path: string): boolean {
  return WORKSPACE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}
