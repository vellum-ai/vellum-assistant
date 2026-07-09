import type { Command } from "commander";

/**
 * The static, action-free description of a top-level `assistant` CLI command:
 * its name, one-line description, and a `configure` step that wires up the
 * help-relevant structure (subcommands, options, arguments, `addHelpText`) but
 * **no** `.action()` handlers.
 *
 * The point of the split is import safety. A command's `.action()` handlers pull
 * in the daemon/IPC graph; its help structure does not. By isolating the
 * structure here (a module that imports only `commander`), the memory capability
 * indexer can build a command's `helpInformation()` — which it embeds so the
 * model can semantically discover CLI commands — without dragging the entire CLI
 * action graph into the daemon's import cycle. The command module applies the
 * same `configure`, then attaches the handlers.
 */
export interface CliCommandHelp {
  name: string;
  description: string;
  /** Configure help-relevant structure on the command. Must not call `.action()`. */
  configure: (command: Command) => void;
}

/**
 * Return a subcommand by name, throwing if absent. Used by command modules to
 * attach `.action()` handlers to the subcommands created by a
 * {@link CliCommandHelp}'s `configure` step.
 */
export function subcommand(parent: Command, name: string): Command {
  const found = parent.commands.find((c) => c.name() === name);
  if (!found) {
    throw new Error(
      `Subcommand "${name}" not found on "${parent.name()}" — is it declared in the command's .help module?`,
    );
  }
  return found;
}
