/**
 * Lazy getter pattern for managed CES API key propagation.
 *
 * In managed mode the assistant API key may arrive after CES handlers are
 * registered (via the handshake callback or a later RPC update). The
 * `ApiKeyRef` + `buildLazyGetters` pattern allows handlers to resolve
 * the key at call time rather than at registration time.
 *
 * Extracted from `managed-main.ts` so the behavioral contract can be
 * tested directly without exercising the full managed bootstrap lifecycle.
 */

import type { ManagedSubjectResolverOptions } from "./subjects/managed.js";
import type { ManagedMaterializerOptions } from "./materializers/managed-platform.js";

/**
 * Mutable reference to the assistant API key. Allows the handshake callback
 * to inject the key provisioned at runtime (which arrives after handlers are
 * built). Handlers read `.current` at call time, not at registration time.
 */
export interface ApiKeyRef {
  current: string;
}

export interface LazyGetterOptions {
  platformBaseUrl: string;
  assistantId: string;
  apiKeyRef: ApiKeyRef;
  envApiKey?: string;
}

export interface LazyGetters {
  getAssistantApiKey: () => string;
  getManagedSubjectOptions: () => ManagedSubjectResolverOptions | undefined;
  getManagedMaterializerOptions: () => ManagedMaterializerOptions | undefined;
}

/**
 * Build lazy getter functions that resolve the API key at call time.
 *
 * Prefers the handshake-provided key (via `apiKeyRef.current`) over the
 * env-var fallback, since in managed mode the env var may not be set
 * (chicken-and-egg: key is provisioned after hatch).
 */
export function buildLazyGetters(opts: LazyGetterOptions): LazyGetters {
  const { platformBaseUrl, assistantId, apiKeyRef, envApiKey } = opts;

  const getAssistantApiKey = (): string =>
    apiKeyRef.current || envApiKey || "";

  const getManagedSubjectOptions = (): ManagedSubjectResolverOptions | undefined => {
    const key = getAssistantApiKey();
    return platformBaseUrl && key && assistantId
      ? { platformBaseUrl, assistantApiKey: key, assistantId }
      : undefined;
  };

  const getManagedMaterializerOptions = (): ManagedMaterializerOptions | undefined => {
    const key = getAssistantApiKey();
    return platformBaseUrl && key && assistantId
      ? { platformBaseUrl, assistantApiKey: key, assistantId }
      : undefined;
  };

  return {
    getAssistantApiKey,
    getManagedSubjectOptions,
    getManagedMaterializerOptions,
  };
}
