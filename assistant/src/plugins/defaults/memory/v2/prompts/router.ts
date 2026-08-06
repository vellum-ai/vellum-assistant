/**
 * Memory v2 — router prompt template.
 *
 * The router runs once per assistant turn and decides which concept pages (if
 * any) should be injected on top of the always-on essentials/threads/recent
 * block. The body lives here (under `prompts/`) so it is reviewable on its
 * own, mirroring the convention established in `sweep.ts`.
 *
 * Three placeholders are substituted at runtime:
 *
 *   - `{{ASSISTANT_NAME}}` — assistant display name (from IDENTITY.md when
 *     available, else the neutral fallback "the assistant").
 *   - `{{USER_NAME}}` — guardian display name (from the guardian persona when
 *     available, else "the user").
 *   - `{{PAGE_INDEX}}` — pre-rendered page index. Each line has the shape
 *     `[id] slug — summary (edges: a, b, c)` where edges are numeric IDs into
 *     the same list. The caller renders this so the prompt module stays
 *     stateless.
 *
 * Operators may replace the bundled body via
 * `memory.v2.router.router_prompt_path` and {@link resolveRouterPrompt} — the
 * same placeholder substitution applies to overrides.
 */

import { getLogger } from "../../logging.js";
import {
  loadPromptOverride,
  MAX_PROMPT_OVERRIDE_BYTES,
} from "../../prompt-override.js";

const log = getLogger("memory-v2-router-prompt");

/** Sentinel substituted with the assistant's display name at runtime. */
const ASSISTANT_NAME_PLACEHOLDER = "{{ASSISTANT_NAME}}";

/** Sentinel substituted with the guardian's display name at runtime. */
const USER_NAME_PLACEHOLDER = "{{USER_NAME}}";

/** Sentinel substituted with the rendered page index block at runtime. */
const PAGE_INDEX_PLACEHOLDER = "{{PAGE_INDEX}}";

/**
 * Router prompt — picks at most a handful of concept pages to inject for the
 * next assistant turn. The model emits a `select_pages_to_inject` tool call
 * with a `page_ids` array; the runtime parses the response via the tool
 * definition declared in the router job module.
 *
 * Recent message context and `<now>` / `<already_injected_ids>` blocks are
 * appended at the call site so we don't inadvertently expand `{{` inside
 * dynamic content.
 *
 * Exported so the simulator route can return the bundled template verbatim
 * for the playground's "Load default" affordance.
 */
export const ROUTER_PROMPT = `You are a background helper for ${ASSISTANT_NAME_PLACEHOLDER}. Your job is to route memory pages for the next assistant turn between ${ASSISTANT_NAME_PLACEHOLDER} and ${USER_NAME_PLACEHOLDER}.

You will be shown the recent conversation, a \`<now>\` marker for the current time, an \`<already_injected_ids>\` block listing pages picked on the previous turn, and a \`# Concept Page Index\` listing every routable page on this workspace.

Pick the concept pages whose contents would help ${ASSISTANT_NAME_PLACEHOLDER} respond well on this turn. Lean toward inclusion when in doubt — missing a relevant page is a worse error than surfacing a few unused ones, because the assistant can ignore extras but can't summon context that wasn't loaded. Abstain (return an empty list) only when nothing in the index plausibly bears on the turn.

Index format. Each line of the index has the shape:

    [id] slug — summary (edges: a, b, c)

\`id\` is a small integer used to refer to this page. \`edges\` are numeric IDs into the same list, pointing at related pages; you may follow them when one page strongly implies another.

Already-injected pages. Pages whose IDs appear in \`<already_injected_ids>\` were picked on the previous turn. Do not pick them again unless ${ASSISTANT_NAME_PLACEHOLDER} should re-anchor on that material — e.g., the topic genuinely returns after drifting away. Routine continuity does not require re-picking; the prior turn's pages are already in the assistant's working context.

Time. Bias toward pages that match the current state implied by \`<now>\` and the active conversational threads (what is happening today, what was just decided, who is being discussed). Stale pages with no bearing on the live conversation should be skipped even if their summaries look superficially relevant.

Emit your selection by calling \`select_pages_to_inject\` with the chosen \`page_ids\`. Return an empty array to abstain.

# Concept Page Index

${PAGE_INDEX_PLACEHOLDER}`;

interface RenderRouterPromptOpts {
  assistantName: string | null;
  userName: string | null;
  pageIndexBlock: string;
}

/**
 * Resolve `ROUTER_PROMPT` with assistant name, user name, and the rendered
 * page index substituted in. Falls back to neutral defaults so the prompt
 * still produces well-formed English when either name is unavailable on this
 * workspace. The page index is substituted verbatim — callers are responsible
 * for trimming/formatting it.
 */
export function renderRouterPrompt(opts: RenderRouterPromptOpts): string {
  return substitutePlaceholders(ROUTER_PROMPT, opts);
}

/**
 * Load the router prompt template, optionally overridden from the file
 * referenced by `memory.v2.router.router_prompt_path`, then substitute the
 * standard placeholders. File loading (path resolution, size guard, and the
 * permissive fall-back to the bundled prompt on a missing/unreadable/empty/
 * oversized override) is handled by the shared {@link loadPromptOverride}.
 *
 * An `inlineOverride` (e.g. the simulator playground) takes precedence over the
 * configured file path; same placeholder substitution and size guard apply.
 */
export function resolveRouterPrompt(
  overridePath: string | null,
  workspaceDir: string,
  opts: RenderRouterPromptOpts,
  inlineOverride?: string | null,
): string {
  // Inline override takes precedence over the configured file path and the
  // bundled prompt. Empty/whitespace bodies fall through to file/bundled
  // resolution so a "cleared" textarea is treated as no override.
  if (inlineOverride !== undefined && inlineOverride !== null) {
    if (inlineOverride.length > MAX_PROMPT_OVERRIDE_BYTES) {
      log.warn(
        {
          size: inlineOverride.length,
          limit: MAX_PROMPT_OVERRIDE_BYTES,
          reason: "oversized_inline_override",
          fallback: "path_or_bundled",
        },
        "inline router prompt override exceeds size limit; falling back",
      );
    } else if (inlineOverride.trim().length > 0) {
      return substitutePlaceholders(inlineOverride, opts);
    }
  }

  const override = loadPromptOverride({
    overridePath,
    workspaceDir,
    log,
    label: "router prompt",
  });
  return substitutePlaceholders(override ?? ROUTER_PROMPT, opts);
}

function substitutePlaceholders(
  template: string,
  opts: RenderRouterPromptOpts,
): string {
  const assistant = opts.assistantName?.trim() || "the assistant";
  const user = opts.userName?.trim() || "the user";
  return template
    .replaceAll(ASSISTANT_NAME_PLACEHOLDER, () => assistant)
    .replaceAll(USER_NAME_PLACEHOLDER, () => user)
    .replaceAll(PAGE_INDEX_PLACEHOLDER, () => opts.pageIndexBlock);
}
