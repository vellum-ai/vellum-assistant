import type { Command } from "commander";

/**
 * Fully declarative description of a top-level `assistant` CLI command and its
 * subcommands. Plain data by design — no action handlers — so plugins (e.g. the
 * memory capability indexer) can import a command's help and iterate over it
 * without dragging in the CLI's daemon/IPC action graph. Command modules apply
 * the same data via {@link applyCommandHelp}, then attach their handlers.
 */
export interface CliCommandHelp {
  name: string;
  description: string;
  /** Extra help appended after the option list (`addHelpText("after", …)`). */
  helpText?: string;
  subcommands?: CliSubcommandHelp[];
}

export interface CliSubcommandHelp {
  name: string;
  description: string;
  options?: CliOptionHelp[];
  /** Extra help appended after the option list (`addHelpText("after", …)`). */
  helpText?: string;
}

export interface CliOptionHelp {
  /** Commander flag spec, e.g. `"--path <file>"`. */
  flags: string;
  description: string;
  /** When true, applied via `requiredOption` (missing → error) rather than `option`. */
  required?: boolean;
}

/**
 * Configure a Commander command from its declarative {@link CliCommandHelp}:
 * appended help text and subcommands (with options). Does not set the top-level
 * name/description — `registerCommand` owns those — and does not attach action
 * handlers; the command module attaches those to the created subcommands.
 */
export function applyCommandHelp(command: Command, help: CliCommandHelp): void {
  if (help.helpText) {
    command.addHelpText("after", help.helpText);
  }
  for (const sub of help.subcommands ?? []) {
    const child = command.command(sub.name).description(sub.description);
    for (const option of sub.options ?? []) {
      if (option.required) {
        child.requiredOption(option.flags, option.description);
      } else {
        child.option(option.flags, option.description);
      }
    }
    if (sub.helpText) {
      child.addHelpText("after", sub.helpText);
    }
  }
}

/** Return a subcommand by name, throwing if absent. */
export function subcommand(parent: Command, name: string): Command {
  const found = parent.commands.find((c) => c.name() === name);
  if (!found) {
    throw new Error(
      `Subcommand "${name}" not found on "${parent.name()}" — is it declared in the command's .help module?`,
    );
  }
  return found;
}
