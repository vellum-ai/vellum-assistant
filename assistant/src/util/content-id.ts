/**
 * Compute a stable, version-independent content ID for an app.
 *
 * Uses a SHA-256 hash of "vellum-assistant:{name}" truncated to 16 hex chars.
 * This must remain consistent across assistant version upgrades so that
 * update detection (comparing bundled content_id to local content_id) works.
 */

import { createHash } from 'node:crypto';

export function computeContentId(name: string): string {
  return createHash('sha256')
    .update(`vellum-assistant:${name}`)
    .digest('hex')
    .slice(0, 16);
}
