import { type Command, Option } from "commander";

/**
 * Fully declarative description of a top-level `assistant` CLI command and its
 * subcommands. Plain data by design — no action handlers — so plugins (e.g. the
 * memory capability indexer) can import a command's help and iterate over it
 * without dragging in the CLI's daemon/IPC action graph. Command modules apply
 * the same data via {@link applyCommandHelp}, then attach their handlers.
 */
export interface CliCommandHelp {
  name: string;
  /**
   * Positional-argument spec appended to the name at registration, e.g.
   * `"<command>"`. Use {@link commandSpec} to build the Commander registration
   * string; `name` stays the bare command name so consumers (dedup, slugs,
   * rendering) never parse argument syntax out of it.
   */
  args?: string;
  description: string;
  /**
   * Positional arguments that carry their own description, applied via
   * Commander's `argument(name, description)` (rendered in the generated
   * `Arguments:` help section). Use `args` instead when the positional needs
   * no description.
   */
  arguments?: CliArgumentHelp[];
  /** Options declared directly on the top-level command. */
  options?: CliOptionHelp[];
  /** Extra help appended after the option list (`addHelpText("after", …)`). */
  helpText?: string;
  subcommands?: CliSubcommandHelp[];
}

export interface CliSubcommandHelp {
  name: string;
  /** Positional-argument spec, e.g. `"<path>"` — see {@link CliCommandHelp.args}. */
  args?: string;
  description: string;
  /**
   * Positional arguments that carry their own description, applied via
   * Commander's `argument(name, description)` (rendered in the generated
   * `Arguments:` help section). Use `args` instead when the positional needs
   * no description.
   */
  arguments?: CliArgumentHelp[];
  options?: CliOptionHelp[];
  /** Extra help appended after the option list (`addHelpText("after", …)`). */
  helpText?: string;
  /** When true, this subcommand runs when the parent is invoked without one. */
  isDefault?: boolean;
  /** Nested subcommand groups (e.g. `avatar character update`). */
  subcommands?: CliSubcommandHelp[];
}

export interface CliArgumentHelp {
  /** Commander argument spec, e.g. `"<channel>"` or `"[value]"`. */
  name: string;
  description: string;
}

export interface CliOptionHelp {
  /** Commander flag spec, e.g. `"--path <file>"` or `"-l, --limit <n>"`. */
  flags: string;
  description: string;
  /** When true, applied via `requiredOption` (missing → error) rather than `option`. */
  required?: boolean;
  /** Default value passed to `option(flags, description, defaultValue)`. */
  defaultValue?: string | number | boolean;
  /** Allowed values, applied via Commander's `Option.choices()` (invalid → error). */
  choices?: readonly string[];
}

function applyOptions(command: Command, options?: CliOptionHelp[]): void {
  for (const option of options ?? []) {
    if (option.choices) {
      const built = new Option(option.flags, option.description).choices([
        ...option.choices,
      ]);
      if (option.required) {
        built.makeOptionMandatory(true);
      }
      if (option.defaultValue !== undefined) {
        built.default(option.defaultValue);
      }
      command.addOption(built);
    } else if (option.required) {
      command.requiredOption(option.flags, option.description);
    } else if (option.defaultValue !== undefined) {
      command.addOption(
        new Option(option.flags, option.description).default(
          option.defaultValue,
        ),
      );
    } else {
      command.option(option.flags, option.description);
    }
  }
}

/**
 * Configure a Commander command from its declarative {@link CliCommandHelp}:
 * top-level options, appended help text, and subcommands (with their options,
 * recursively). Does not set the top-level name/description — `registerCommand`
 * owns those — and does not attach action handlers; the command module attaches
 * those to the command or its subcommands.
 */
export function applyCommandHelp(command: Command, help: CliCommandHelp): void {
  for (const argument of help.arguments ?? []) {
    command.argument(argument.name, argument.description);
  }
  applyOptions(command, help.options);
  if (help.helpText) {
    command.addHelpText("after", help.helpText);
  }
  applySubcommands(command, help.subcommands);
}

function applySubcommands(parent: Command, subs?: CliSubcommandHelp[]): void {
  for (const sub of subs ?? []) {
    const child = parent
      .command(commandSpec(sub), { isDefault: sub.isDefault ?? false })
      .description(sub.description);
    for (const argument of sub.arguments ?? []) {
      child.argument(argument.name, argument.description);
    }
    applyOptions(child, sub.options);
    if (sub.helpText) {
      child.addHelpText("after", sub.helpText);
    }
    applySubcommands(child, sub.subcommands);
  }
}

/**
 * Commander registration spec for a command: the bare name plus its
 * positional-argument spec, if any (`"bash <command>"`, `"add <path>"`).
 */
export function commandSpec(
  help: Pick<CliCommandHelp, "name" | "args">,
): string {
  return help.args ? `${help.name} ${help.args}` : help.name;
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
