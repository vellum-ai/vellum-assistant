/**
 * `stop` hook for the echo plugin.
 *
 * Purely observational — logs one structured line to stderr and returns
 * `void`, leaving the stop decision untouched.
 *
 * Convention: the default export is the function the harness invokes.
 */

import type { StopContext } from "@vellumai/plugin-api";

import { emit } from "../src/emit.js";

export default async function stop(ctx: StopContext): Promise<void> {
  emit("stop", ctx.conversationId);
}
