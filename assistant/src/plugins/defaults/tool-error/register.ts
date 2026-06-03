/**
 * Default `tool-error` plugin.
 *
 * Contributes a `post-tool-use` hook that coaches the model to retry or report
 * a failed tool call, bounded per tool so an unrecoverable error doesn't churn.
 * The decision logic lives in `./hooks/post-tool-use.ts`. Defaults register
 * before user plugins and this plugin registers after tool-result-truncate, so
 * the hook sees an already size-bounded result and its appended notice survives.
 */

import { type Plugin } from "../../types.js";
import postToolUse from "./hooks/post-tool-use.js";
import pkg from "./package.json" with { type: "json" };

export const defaultToolErrorPlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  hooks: {
    "post-tool-use": postToolUse,
  },
};
