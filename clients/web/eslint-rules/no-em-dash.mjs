/**
 * Custom ESLint rule: no-em-dash.
 *
 * The repo bans em dashes (root `AGENTS.md`, "Em Dashes"): in user-facing
 * copy, code comments, documentation, commit messages, and PR descriptions.
 * The ban existed for a while with nothing enforcing it, and a rule written
 * down but never checked is a rule that gets broken by whoever did not reread
 * the file that morning. This checks the two places ESLint can see: comments,
 * and the strings a bundle ships.
 *
 * User-facing copy is the strict case. The assistant's own system prompt
 * forbids em dashes (`assistant/src/prompts/templates/SOUL.md`), so a UI
 * string carrying one is written in a different voice from the assistant
 * standing next to it.
 *
 * This rule is scoped, not global. `eslint.config.mjs` enables it only for the
 * paths in `emDashEnforcedPaths`, for the same reason
 * `local/no-untranslated-strings` is scoped: `clients/web/src` holds thousands
 * of pre-existing em dashes, `AGENTS.md` says not to sweep them
 * retroactively, and a rule that reports thousands at once gets switched off
 * rather than obeyed. Scoped, an area that has been cleaned cannot regress.
 *
 * No autofix. What replaces an em dash depends on what the sentence is doing:
 * a period when it joins two independent clauses, a comma for an aside,
 * parentheses for a true parenthetical, a colon when what follows explains
 * what precedes. A blanket substitution would produce worse prose than the
 * em dash it replaced, and would do it silently across a whole file.
 *
 * Escape hatch, for text that genuinely must carry the character (a parser
 * fixture, a test asserting this rule, prose quoted from elsewhere):
 *
 *   // eslint-disable-next-line local/no-em-dash -- fixture for the sweeper
 */

/**
 * U+2014 EM DASH, written as an escape so this file does not contain the
 * character it bans and so the rule stays quiet on its own source.
 */
const EM_DASH = "\u2014";

const MESSAGE_ID = "emDash";

/**
 * Every index of {@link EM_DASH} in `text`.
 *
 * All of them, not just the first: a single comment line routinely carries an
 * opening and a closing one around an aside, and reporting one would send
 * someone back for a second pass.
 */
function emDashIndexes(text) {
  const indexes = [];
  let from = text.indexOf(EM_DASH);
  while (from !== -1) {
    indexes.push(from);
    from = text.indexOf(EM_DASH, from + 1);
  }
  return indexes;
}

export const noEmDash = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow em dashes in comments and string literals. See root AGENTS.md.",
    },
    schema: [],
    messages: {
      [MESSAGE_ID]:
        "Em dash is not allowed here. Use a period, comma, colon, parentheses, or a plain hyphen instead (see AGENTS.md).",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /**
     * Report every em dash in `text`, which starts at `baseIndex` in the file.
     *
     * Positions are resolved through `getLocFromIndex` rather than counted
     * locally, so a dash on the fourth line of a block comment reports on that
     * line instead of on the comment's first.
     */
    function reportEach(text, baseIndex) {
      for (const offset of emDashIndexes(text)) {
        const start = baseIndex + offset;
        context.report({
          loc: {
            start: sourceCode.getLocFromIndex(start),
            end: sourceCode.getLocFromIndex(start + EM_DASH.length),
          },
          messageId: MESSAGE_ID,
        });
      }
    }

    return {
      // Comments hang off no node, so they are swept once per file rather
      // than visited.
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          reportEach(comment.value, comment.range[0] + 2);
        }
      },

      // Each of these reads its own source slice rather than the parsed
      // value, so an index into the text is an index into the file and the
      // report lands on the character itself. A parsed value has had its
      // quotes stripped and its escapes resolved, which shifts every offset
      // after the first `\n`.
      Literal(node) {
        if (typeof node.value !== "string") {
          return;
        }
        reportEach(sourceCode.getText(node), node.range[0]);
      },

      // The static halves of a template. Interpolations are expressions and
      // are visited on their own.
      TemplateElement(node) {
        reportEach(sourceCode.getText(node), node.range[0]);
      },

      JSXText(node) {
        reportEach(sourceCode.getText(node), node.range[0]);
      },
    };
  },
};
