/**
 * The assembled runtime injector chain.
 *
 * Injection is not a plugin contribution: the first-party injectors are
 * imported directly and sorted once, by ascending `order`, into the single
 * sequence `applyRuntimeInjections` walks each turn. This co-locates the
 * chain with the memory-retrieval domain it serves, rather than aggregating
 * injectors out of the plugin registry.
 *
 * The chain combines the default injectors ({@link defaultInjectors}) with the
 * memory-v3 injector ({@link memoryV3Injector}). The sort mirrors the previous
 * registry aggregation (`Array.prototype.sort` is stable, so injectors sharing
 * an `order` keep their listed order), so the produced sequence — and therefore
 * the injected content — is identical.
 *
 * The chain is assembled lazily on first access. `register.ts` and
 * `conversation-runtime-assembly.ts` form an import cycle (the injectors read
 * `readPkbContext` from the assembly module), so eagerly reading
 * `defaultInjectors` at module-evaluation time would observe it in its
 * temporal dead zone. Deferring assembly to the first turn sidesteps the cycle
 * entirely.
 */

import { memoryV3Injector } from "../../../memory/v3/shadow-plugin.js";
import type { Injector } from "../../types.js";
import { defaultInjectors } from "../injectors/register.js";

let cachedChain: Injector[] | null = null;

/** The order-sorted runtime injector chain, assembled once and memoized. */
export function getInjectorChain(): Injector[] {
  if (cachedChain === null) {
    cachedChain = [...defaultInjectors, memoryV3Injector].sort(
      (a, b) => a.order - b.order,
    );
  }
  return cachedChain;
}
