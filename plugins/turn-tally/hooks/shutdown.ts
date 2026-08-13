/**
 * `shutdown` hook: closes the tally database handle opened by `init`.
 * Best-effort teardown only; every write is already durable, and
 * `shutdown` may run in a different process than `init`, in which case
 * there is no open handle and this is a no-op.
 */

import type { HookFunction, ShutdownContext } from "@vellumai/plugin-api";

import { closeTallyStore } from "../src/tally-store.js";

const shutdown: HookFunction<ShutdownContext> = async () => {
  closeTallyStore();
};

export default shutdown;
