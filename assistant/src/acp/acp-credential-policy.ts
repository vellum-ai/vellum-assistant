/**
 * Read-policy helpers for the `acp/<field>` credentials the ACP spawn path
 * consumes.
 *
 * Split out of `prepare-agent-env.ts` so modules that only need the policy
 * rules (the Connect Claude flow, the token-refresh path) do not have to
 * import the env-injection module, which imports them back.
 */

import {
  getCredentialMetadata,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import { ACP_SERVICE } from "./acp-credentials.js";

/** The only tool permitted to read `acp/<field>` credentials at spawn time. */
export const ACP_SPAWN_TOOL = "acp_spawn";

/**
 * Ensure an `acp/<field>` credential has metadata that allows the
 * `acp_spawn` tool to read it, but only for legacy/unmanaged cases:
 *
 * - No metadata at all: create with `allowedTools: ["acp_spawn"]`.
 * - Metadata exists with an empty `allowedTools`: default provisioning
 *   path (user ran `credentials set` without `--allowed-tools`), add it.
 * - Metadata exists with a non-empty `allowedTools`: explicit policy set
 *   by the user/admin. Respect it even if `acp_spawn` is absent; the
 *   broker will deny the read and the caller decides whether that's fatal.
 */
export function ensureAcpCredentialPolicy(
  field: string,
  usageDescription: string,
): void {
  const meta = getCredentialMetadata(ACP_SERVICE, field);
  if (!meta) {
    upsertCredentialMetadata(ACP_SERVICE, field, {
      allowedTools: [ACP_SPAWN_TOOL],
      usageDescription,
    });
    return;
  }
  const tools = meta.allowedTools ?? [];
  if (tools.length === 0) {
    upsertCredentialMetadata(ACP_SERVICE, field, {
      allowedTools: [ACP_SPAWN_TOOL],
    });
  }
}

/**
 * Force-grant the `acp_spawn` read policy on `acp/<field>`, unioning it into any
 * existing `allowedTools`. Unlike {@link ensureAcpCredentialPolicy} (which
 * PRESERVES an explicit non-empty policy so a passive spawn can't silently widen
 * it), this is for the EXPLICIT Connect flow: a user connecting Claude is a
 * deliberate opt-in to `acp_spawn`, so granting it makes the CTA actually repair
 * a policy-denied credential instead of dead-looping the missing-token card.
 */
export function grantAcpSpawnPolicy(
  field: string,
  usageDescription: string,
): void {
  const meta = getCredentialMetadata(ACP_SERVICE, field);
  if (!meta) {
    upsertCredentialMetadata(ACP_SERVICE, field, {
      allowedTools: [ACP_SPAWN_TOOL],
      usageDescription,
    });
    return;
  }
  const tools = meta.allowedTools ?? [];
  if (!tools.includes(ACP_SPAWN_TOOL)) {
    upsertCredentialMetadata(ACP_SERVICE, field, {
      allowedTools: [...tools, ACP_SPAWN_TOOL],
    });
  }
}

/**
 * Whether the `acp_spawn` broker read for `acp/<field>` would actually be
 * permitted, mirroring {@link ensureAcpCredentialPolicy}'s grant rules: a
 * missing or empty `allowedTools` is auto-granted `acp_spawn` at spawn time, so
 * it can read; a non-empty explicit policy is respected as-is, so it can read
 * only when it lists `acp_spawn`. Lets a connected-status check avoid reporting
 * "connected" for a token the spawn is policy-denied from reading (which would
 * otherwise hide the repair CTA and trap the user in a missing-token loop).
 */
export function acpSpawnCanReadCredential(field: string): boolean {
  const meta = getCredentialMetadata(ACP_SERVICE, field);
  if (!meta) {
    return true;
  }
  const tools = meta.allowedTools ?? [];
  return tools.length === 0 || tools.includes(ACP_SPAWN_TOOL);
}
