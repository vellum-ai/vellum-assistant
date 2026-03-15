/**
 * HTTP audit summary generation for the Credential Execution Service.
 *
 * Produces token-free audit summaries of credentialed HTTP operations.
 * These summaries are stored in the CES audit log and may be exposed
 * to the assistant runtime for observability — they must never contain
 * secret values, auth tokens, or raw credential material.
 *
 * Audit summaries capture:
 * - What was accessed (method, URL template, status code)
 * - Which credential and grant were used
 * - Whether the operation succeeded
 * - Timing metadata
 */

import { randomUUID } from "node:crypto";

import type { AuditRecordSummary } from "@vellumai/ces-contracts";
import { derivePathTemplate } from "./path-template.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HttpAuditInput {
  /** CES credential handle used for this request. */
  credentialHandle: string;
  /** Grant ID that authorised this request. */
  grantId: string;
  /** CES session ID. */
  sessionId: string;
  /** HTTP method. */
  method: string;
  /** Raw target URL (will be templated for the audit record). */
  url: string;
  /** Whether the HTTP operation succeeded. */
  success: boolean;
  /** HTTP status code (if available). */
  statusCode?: number;
  /** Error message if the operation failed (must not contain secrets). */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

/**
 * Generate a token-free audit record summary for an HTTP operation.
 *
 * The `target` field uses the path template (with placeholders) rather
 * than the raw URL to avoid leaking path-level identifiers that might
 * be sensitive (e.g. personal resource IDs). The method is prepended
 * for readability: `GET https://api.example.com/users/{:num}`.
 */
export function generateHttpAuditSummary(
  input: HttpAuditInput,
): AuditRecordSummary {
  let target: string;
  try {
    const template = derivePathTemplate(input.url);
    target = `${input.method.toUpperCase()} ${template}`;
  } catch {
    // If URL parsing fails, use a safe redacted placeholder
    target = `${input.method.toUpperCase()} [invalid-url]`;
  }

  // Append status code if available
  if (input.statusCode !== undefined) {
    target += ` -> ${input.statusCode}`;
  }

  return {
    auditId: randomUUID(),
    grantId: input.grantId,
    credentialHandle: input.credentialHandle,
    toolName: "http",
    target,
    sessionId: input.sessionId,
    success: input.success,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    timestamp: new Date().toISOString(),
  };
}
