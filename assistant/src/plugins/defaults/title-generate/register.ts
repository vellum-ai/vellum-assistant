/**
 * Default `title-generate` plugin.
 *
 * Contributes a `user-prompt-submit` hook that kicks off conversation-title
 * generation from the submitted prompt. The trigger lives in
 * `./hooks/user-prompt-submit.ts`; persistence and the resulting
 * `conversation_title_updated` / `sync_changed` broadcast are owned by the
 * title service (`memory/conversation-title-service.ts`).
 *
 * Registered via a side-effect import from
 * `daemon/external-plugins-bootstrap.ts` so it is present in the registry
 * by the time {@link bootstrapPlugins} runs.
 */

import { type Plugin } from "../../types.js";
import userPromptSubmit from "./hooks/user-prompt-submit.js";
import pkg from "./package.json" with { type: "json" };

export const defaultTitleGeneratePlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  hooks: {
    "user-prompt-submit": userPromptSubmit,
  },
};
