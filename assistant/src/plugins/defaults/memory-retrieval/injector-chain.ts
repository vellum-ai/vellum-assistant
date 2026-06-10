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
 * memory-v3 injectors ({@link memoryV3Injector} — frozen net-new cards — and
 * {@link memoryV3SpotlightInjector} — the ephemeral section spotlight). The
 * sort mirrors the previous registry aggregation (`Array.prototype.sort` is
 * stable, so injectors sharing an `order` keep their listed order), so the
 * produced sequence — and therefore the injected content — is identical.
 *
 * The chain is assembled lazily on first access and memoized, so the sort runs
 * once per process rather than per turn and module evaluation stays free of any
 * ordering assumptions about when `defaultInjectors` finishes initializing.
 */

import type { Injector } from "../../types.js";
import {
  memoryV3Injector,
  memoryV3SpotlightInjector,
} from "../memory-v3-shadow/injector.js";
import { defaultInjectors } from "./injectors.js";

let cachedChain: Injector[] | null = null;

/** The order-sorted runtime injector chain, assembled once and memoized. */
export function getInjectorChain(): Injector[] {
  if (cachedChain === null) {
    cachedChain = [
      ...defaultInjectors,
      memoryV3Injector,
      memoryV3SpotlightInjector,
    ].sort((a, b) => a.order - b.order);
  }
  return cachedChain;
}
