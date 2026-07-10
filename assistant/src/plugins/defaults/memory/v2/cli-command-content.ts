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
  for (const sub of help.subcommands ?? []) {
    const lines = [`${help.name} ${sub.name} — ${sub.description}`];
    const options = renderOptionLines(sub.options);
    if (options) {
      lines.push(options);
    }
    if (sub.helpText) {
      lines.push(sub.helpText.trim());
    }
    sections.push(lines.join("\n"));
  }
  return buildCliCommandContent(
    help.name,
    help.description,
    sections.join("\n\n"),
  );
}

function renderOptionLines(options: CliCommandHelp["options"]): string | null {
  if (!options?.length) {
    return null;
  }
  return options
    .map(
      (option) =>
        `  ${option.flags}${option.required ? " (required)" : ""}  ${option.description}`,
    )
    .join("\n");
}
