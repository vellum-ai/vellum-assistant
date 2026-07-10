/**
 * Render the prose-style capability statement embedded into the unified
 * `memory_v2_concept_pages` Qdrant collection (under the `cli-commands/<name>`
 * slug prefix). Mirrors `buildSkillContent` in shape — a short prose lead-in
 * followed by the dense capability material — so activation scoring weighs
 * both natural-language intent and structured help text.
 *
 * Intentionally uncapped: CLI `--help` output averages 1–2 KB and the longest
 * (browser, oauth) hits ~3.4 KB. The embedding backend handles inputs of this
 * size without trouble, and trimming would drop the very examples and flag
 * descriptions that make commands semantically findable.
 */

import type { CLI_COMMAND_HELP } from "@vellumai/plugin-api";

/** Element type of the plugin-api's declarative CLI help constant. */
type CliCommandHelp = (typeof CLI_COMMAND_HELP)[number];
/** Subcommand element type — recursive via its own `subcommands` field. */
type CliSubcommandHelp = NonNullable<CliCommandHelp["subcommands"]>[number];

export function buildCliCommandContent(
  name: string,
  description: string,
  helpText: string,
): string {
  return `The "assistant ${name}" CLI command is available. ${description}.\n\nFull help:\n${helpText}`;
}

/**
 * Render capability content from a command's declarative {@link CliCommandHelp}
 * (flags, subcommands, help prose) for commands that have adopted the static-help
 * split. Produces the same prose lead-in as {@link buildCliCommandContent} with a
 * data-derived help body, so commands read declaratively are indexed the same way
 * as those still read from the Commander tree.
 */
export function buildCliCommandHelpContent(help: CliCommandHelp): string {
  const sections: string[] = [];
  const topOptions = renderOptionLines(help.options);
  if (topOptions) {
    sections.push(topOptions);
  }
  if (help.helpText) {
    sections.push(help.helpText.trim());
  }
  collectSubcommandSections(help.name, help.subcommands, sections);
  return buildCliCommandContent(
    help.name,
    help.description,
    sections.join("\n\n"),
  );
}

/**
 * Walk the subcommand tree depth-first, emitting one section per subcommand
 * headed by its full command path (`backup destinations add <path> — …`) so
 * nested groups index under the phrase a user would actually type.
 */
function collectSubcommandSections(
  path: string,
  subs: readonly CliSubcommandHelp[] | undefined,
  sections: string[],
): void {
  for (const sub of subs ?? []) {
    const subPath = `${path} ${sub.name}`;
    const heading = `${subPath}${sub.args ? ` ${sub.args}` : ""} — ${sub.description}`;
    const lines = [heading];
    const options = renderOptionLines(sub.options);
    if (options) {
      lines.push(options);
    }
    if (sub.helpText) {
      lines.push(sub.helpText.trim());
    }
    sections.push(lines.join("\n"));
    collectSubcommandSections(subPath, sub.subcommands, sections);
  }
}

function renderOptionLines(options: CliCommandHelp["options"]): string | null {
  if (!options?.length) {
    return null;
  }
  return options
    .map((option) => {
      const qualifiers = [
        option.required ? " (required)" : "",
        option.choices?.length
          ? ` (choices: ${option.choices.join(", ")})`
          : "",
        option.defaultValue !== undefined
          ? ` (default: ${option.defaultValue})`
          : "",
      ].join("");
      return `  ${option.flags}${qualifiers}  ${option.description}`;
    })
    .join("\n");
}
