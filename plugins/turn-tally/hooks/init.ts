/**
 * `init` hook: parses `config.json` and opens the plugin-owned tally
 * database (`tally.sqlite` in the plugin's storage dir), applying its
 * schema idempotently. Fail-open: when the store cannot be opened the
 * plugin keeps loading and every tally operation degrades to a no-op.
 */

import { join } from "node:path";

import type { HookFunction, InitContext } from "@vellumai/plugin-api";

import { parseConfig, setActiveConfig } from "../src/plugin-config.js";
import { openTallyStore } from "../src/tally-store.js";

const init: HookFunction<InitContext> = async (ctx) => {
  const config = parseConfig(ctx.config);
  setActiveConfig(config);
  openTallyStore(join(ctx.pluginStorageDir, "tally.sqlite"));
  ctx.logger.info(
    { trackToolNames: config.trackToolNames },
    "turn-tally store ready",
  );
};

export default init;
