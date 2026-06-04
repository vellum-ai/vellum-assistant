/**
 * Default `title-generate` plugin.
 *
 * Contributes two hooks, both pure triggers that delegate the title work to
 * the service (`memory/conversation-title-service.ts`):
 *
 * - `user-prompt-submit` (`./hooks/user-prompt-submit.ts`) — first-pass title
 *   generation from the submitted prompt.
 * - `stop` (`./hooks/stop.ts`) — second-pass regeneration once the
 *   conversation reaches its third user turn, for a title that reflects the
 *   established topic.
 *
 * Persistence and the resulting `conversation_title_updated` / `sync_changed`
 * broadcast are owned by the title service.
 *
 * Registered via a side-effect import from
 * `daemon/external-plugins-bootstrap.ts` so it is present in the registry
 * by the time {@link bootstrapPlugins} runs.
 */

import { type Plugin } from "../../types.js";
import stop from "./hooks/stop.js";
import userPromptSubmit from "./hooks/user-prompt-submit.js";
import pkg from "./package.json" with { type: "json" };

export const defaultTitleGeneratePlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  hooks: {
    "user-prompt-submit": userPromptSubmit,
    stop,
  },
};
