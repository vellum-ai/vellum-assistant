/**
 * Per-connection managed credential option resolution.
 *
 * In managed mode the assistant API key and assistant ID arrive after CES
 * handlers are registered (via the handshake or a later RPC update) and differ
 * per connection. Rather than reading process-global mutable refs, handlers
 * resolve managed subject/materializer options from the calling connection's
 * `SessionContext` at call time via `resolveManagedOptions`.
 *
 * Extracted from `managed-main.ts` so the behavioral contract can be tested
 * directly without exercising the full managed bootstrap lifecycle.
 */

import type { SessionContext } from "./server.js";
import type { ManagedSubjectResolverOptions } from "./subjects/managed.js";
import type { ManagedMaterializerOptions } from "./materializers/managed-platform.js";

/**
 * The managed subject- and materializer-resolution options for a single
 * connection. Both carry the same `{ platformBaseUrl, assistantApiKey,
 * assistantId }` shape, so they reference one underlying object.
 */
export interface ManagedOptionsPair {
  subjectOptions: ManagedSubjectResolverOptions;
  materializerOptions: ManagedMaterializerOptions;
}

export interface ResolveManagedOptionsInput {
  /** Platform base URL (from `VELLUM_PLATFORM_URL`); "" when unset. */
  platformBaseUrl: string;
  /** Env-var API key fallback (`ASSISTANT_API_KEY`), used when the connection forwarded none. */
  envApiKey?: string;
  /** The calling connection's session context. */
  ctx: SessionContext;
}

/**
 * Resolve managed subject/materializer options from a connection's context.
 *
 * The API key prefers the connection's handshake-provided key, falling back to
 * the env var (in managed mode the env var may be unset — the key is
 * provisioned after hatch). Returns undefined when any required value is
 * missing (no platform URL, no key, or no assistant ID) so materialization
 * fails closed rather than proceeding with incomplete or stale identity.
 */
export function resolveManagedOptions(
  input: ResolveManagedOptionsInput,
): ManagedOptionsPair | undefined {
  const { platformBaseUrl, envApiKey, ctx } = input;
  const assistantApiKey = ctx.assistantApiKey || envApiKey || "";
  const assistantId = ctx.assistantId;

  if (!platformBaseUrl || !assistantApiKey || !assistantId) {
    return undefined;
  }

  const options = { platformBaseUrl, assistantApiKey, assistantId };
  return { subjectOptions: options, materializerOptions: options };
}
