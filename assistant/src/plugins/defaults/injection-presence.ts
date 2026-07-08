/**
 * Shared injection-presence detection for the default injectors.
 *
 * Several injectors re-inject a persisted block only when the working history
 * does not already carry it (first turn / right after compaction), and skip it
 * otherwise to keep the conversation prefix stable for prefix caching. That
 * "is it already present?" check is identical across the `workspace`
 * (`<workspace>`, NOW.md) and memory (`<knowledge_base>`, `<info>`) plugins, so
 * it lives here as one helper both import rather than being duplicated per
 * plugin.
 */

import type { Message } from "@vellumai/plugin-api";

import type { InjectionMatcher } from "../../context/strip-injections.js";

/**
 * Whether a block matching any of the given matchers is already present in the
 * turn's working messages — used to skip re-injection of a block the history
 * already carries.
 *
 * Recognizes both the canonical standalone form (a text block that IS the
 * wrapper) and the "flattened" form where the wrapper sits as a newline-
 * delimited section inside a larger text block (see {@link textCarriesInjection}).
 *
 * Detection is intentionally BROADER than `stripUserTextBlocksByPrefix`, which
 * stays whole-block-only: re-injection must be suppressed even when a historical
 * user message's separate injection blocks have been collapsed into one text
 * block, whereas the strip must never delete a block that also holds the user's
 * own text. (A flattened block is summarized away at the next compaction, where
 * fresh injection resumes.)
 */
export function hasInjectedUserTextBlock(
  runMessages: Message[] | undefined,
  matchers: readonly InjectionMatcher[],
): boolean {
  if (!runMessages) return false;
  return runMessages.some(
    (message) =>
      message.role === "user" &&
      message.content.some(
        (block) =>
          block.type === "text" &&
          matchers.some((m) => textCarriesInjection(block.text, m)),
      ),
  );
}

/**
 * Whether `text` carries an injected block matching `matcher`, recognizing both
 * the canonical standalone form (the text IS the wrapper) and a "flattened"
 * form where the wrapper sits as a newline-delimited section inside a larger
 * text block.
 *
 * The flattened form arises when a historical user message's separate injection
 * content blocks get collapsed into a single text block joined with "\n" —
 * observed when a daemon restart / plugin hot-reload rebuilt the rendered
 * history mid-conversation. Without recognizing it, the standalone-only check
 * returns false for the carried block and the injector re-injects a duplicate
 * `<workspace>` / `<info>` onto the new tail.
 *
 * Anchoring on line boundaries ("\n" before the opening tag, and "\n" or the
 * block edge after the closing tag) keeps the false-positive surface as narrow
 * as the standalone check: ordinary prose would have to contain the exact
 * wrapper as its own line-delimited section to be mistaken for an injection. The
 * `{ prefix, suffix }` form still requires BOTH tags, so a message that opens
 * (but never closes) an injection-like tag never suppresses injection.
 */
function textCarriesInjection(
  text: string,
  matcher: InjectionMatcher,
): boolean {
  if (typeof matcher === "string") {
    return text.startsWith(matcher) || text.includes(`\n${matcher}`);
  }
  const { prefix, suffix } = matcher;
  const hasOpen = text.startsWith(prefix) || text.includes(`\n${prefix}`);
  const hasClose = text.endsWith(suffix) || text.includes(`${suffix}\n`);
  return hasOpen && hasClose;
}
