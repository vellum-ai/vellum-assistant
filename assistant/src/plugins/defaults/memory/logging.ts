/**
 * The memory plugin's single logging channel. Every module in this plugin
 * obtains its logger here rather than importing host `util/logger` directly,
 * so the host import below is the plugin's sole logging escape (tracked by
 * `plugin-import-boundary-guard.test.ts`).
 *
 * A plain forward is deliberate: memory creates module-scoped loggers in
 * files that also run inside the jobs worker and CLI processes, where no
 * plugin bootstrap (and therefore no `InitContext.logger`) exists. Deriving
 * from the host-provided plugin logger requires a per-process binding story
 * first; centralizing the import here keeps that cutover a one-file change.
 */
import { getLogger as getHostLogger } from "../../../util/logger.js";

export function getLogger(name: string) {
  return getHostLogger(name);
}
