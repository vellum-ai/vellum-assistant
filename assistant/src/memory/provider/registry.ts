/**
 * `MemoryProviderRegistry` — a name-keyed registry of memory-provider
 * factories.
 *
 * Memory systems (graph/v2/v3) register a factory under their
 * `MemoryProviderId`; daemon core resolves the active provider from
 * configuration. Until a provider is registered for the resolved id, `resolve`
 * returns a null provider that contributes nothing — no injection, no tools,
 * no post-turn work. No call site consumes this registry yet.
 */

import type { MemoryConfig } from "../../config/schemas/memory.js";
import type { InjectionBlock } from "../../plugins/types.js";
import type { RouteDefinition } from "../../runtime/routes/types.js";
import type { ToolDefinition } from "../../tools/types.js";
import type { MemoryProvider, MemoryProviderId } from "./types.js";

/**
 * A no-op `MemoryProvider`. Retrieval returns empty injection, post-turn and
 * lifecycle hooks resolve immediately, and it contributes no tools. Used as
 * the safe fallback when no provider is registered for a resolved id.
 */
export class NullMemoryProvider implements MemoryProvider {
  readonly id: MemoryProviderId = "none";

  async retrieveForContext(): Promise<InjectionBlock[]> {
    return [];
  }

  async retrieveForTurn(): Promise<InjectionBlock[]> {
    return [];
  }

  async onTurnCommit(): Promise<void> {}

  provideTools(): ToolDefinition[] {
    return [];
  }

  provideRoutes(): RouteDefinition[] {
    return [];
  }

  async init(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

/** Factory producing a `MemoryProvider` instance. */
export type MemoryProviderFactory = () => MemoryProvider;

export class MemoryProviderRegistry {
  private readonly factories = new Map<
    MemoryProviderId,
    MemoryProviderFactory
  >();

  /**
   * Register a factory for a provider id. Throws if `id` is already
   * registered — registration is a one-time wiring step, so a duplicate
   * indicates a programming error rather than an intended override.
   */
  register(id: MemoryProviderId, factory: MemoryProviderFactory): void {
    if (this.factories.has(id)) {
      throw new Error(`Memory provider already registered for id: ${id}`);
    }
    this.factories.set(id, factory);
  }

  /**
   * Resolve the provider for the given memory config. The concrete mapping
   * from `config.provider` (including `"auto"`) to a registered id is wired in
   * a later change; for now, when no provider is registered for the resolved
   * id, a {@link NullMemoryProvider} is returned so callers always get a safe,
   * behavior-neutral provider.
   */
  resolve(config: MemoryConfig): MemoryProvider {
    const requested = config.provider;
    if (requested !== "auto") {
      const factory = this.factories.get(requested);
      if (factory) {
        return factory();
      }
    }
    return new NullMemoryProvider();
  }
}
