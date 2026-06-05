/**
 * No-op `post-compact` scaffolding for the memory-v3-shadow plugin.
 *
 * v3 re-injection after mid-turn compaction is not yet owned by this plugin —
 * the active injector still runs through the static chain. Once the
 * post-compaction hook API stabilizes we will import `memoryV3Injector` from
 * `../injector.js` and re-apply it here. Until then this hook does nothing.
 */

import type { PluginHookFn } from "@vellumai/plugin-api";

const postCompact: PluginHookFn = async () => {};

export default postCompact;
