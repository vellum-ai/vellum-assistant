/**
 * Canonical proposal rendering and deterministic hashing.
 *
 * Both the assistant and CES must produce identical human-readable text and
 * proposal hashes for the same proposal object. This module provides the
 * shared implementations so neither side has to duplicate the logic.
 *
 * Hashing algorithm:
 *   1. Recursively sort object keys (depth-first).
 *   2. Serialize to a canonical JSON string with no whitespace.
 *   3. SHA-256 hash the UTF-8 bytes and return a lowercase hex digest.
 *
 * This matches the algorithm used by `tool-approval-digest.ts` in the
 * assistant, ensuring consistency across the approval pipeline.
 */

import { createHash } from "node:crypto";
import type { GrantProposal } from "./grants.js";

// ---------------------------------------------------------------------------
// Canonical JSON serialization
// ---------------------------------------------------------------------------

/**
 * Recursively sort all object keys and return a deterministic JSON string.
 *
 * Handles nested objects, arrays (element order preserved), and primitive
 * values. `undefined` values inside objects are omitted (matching
 * JSON.stringify semantics). `null` is preserved.
 */
export function canonicalJsonSerialize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (value == null) return value;

  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  // Primitive — number, string, boolean
  return value;
}

// ---------------------------------------------------------------------------
// Proposal hashing
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic SHA-256 hex digest for a grant proposal.
 *
 * Two proposals with the same canonical content (regardless of key ordering)
 * will always produce the same hash. This hash is used to match grant
 * decisions to proposals in the approval pipeline.
 */
export function hashProposal(proposal: GrantProposal): string {
  const canonical = canonicalJsonSerialize(proposal);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Human-readable proposal rendering
// ---------------------------------------------------------------------------

/**
 * Render a grant proposal as a human-readable text block suitable for
 * display in approval UIs and guardian notifications.
 *
 * The rendering is deterministic for the same proposal, so both assistant
 * and CES produce identical text.
 */
export function renderProposal(proposal: GrantProposal): string {
  switch (proposal.type) {
    case "http":
      return renderHttpProposal(proposal);
    case "command":
      return renderCommandProposal(proposal);
    default: {
      const _exhaustive: never = proposal;
      throw new Error(`Unknown proposal type: ${(_exhaustive as GrantProposal).type}`);
    }
  }
}

function renderHttpProposal(proposal: GrantProposal & { type: "http" }): string {
  const lines: string[] = [
    `Authenticated HTTP Request`,
    `  Method: ${proposal.method}`,
    `  URL: ${proposal.url}`,
    `  Credential: ${proposal.credentialHandle}`,
    `  Purpose: ${proposal.purpose}`,
  ];

  if (proposal.allowedUrlPatterns && proposal.allowedUrlPatterns.length > 0) {
    lines.push(`  Allowed URL patterns:`);
    for (const pattern of proposal.allowedUrlPatterns) {
      lines.push(`    - ${pattern}`);
    }
  }

  return lines.join("\n");
}

function renderCommandProposal(
  proposal: GrantProposal & { type: "command" },
): string {
  const lines: string[] = [
    `Authenticated Command Execution`,
    `  Command: ${proposal.command}`,
    `  Credential: ${proposal.credentialHandle}`,
    `  Purpose: ${proposal.purpose}`,
  ];

  if (
    proposal.allowedCommandPatterns &&
    proposal.allowedCommandPatterns.length > 0
  ) {
    lines.push(`  Allowed command patterns:`);
    for (const pattern of proposal.allowedCommandPatterns) {
      lines.push(`    - ${pattern}`);
    }
  }

  return lines.join("\n");
}
