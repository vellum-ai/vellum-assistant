import type { Command } from "commander";

const JSON_FLAG = "--json";

/**
 * Register a `--json` option on every leaf command in the tree that does not
 * already declare one.
 *
 * Commander only recognizes an option at the position of the command it is
 * attached to, so a single option on the root program would still reject
 * `assistant status --json` with "unknown option '--json'". Attaching `--json`
 * to each leaf command makes the flag accepted everywhere it is actually
 * invoked, which is what callers (and agents) expect when they append `--json`
 * to a command.
 *
 * Only **leaf** commands (those with no subcommands) get the option. Commander
 * consumes a recognized option at the *outermost* command that declares it,
 * even when the flag appears after the subcommand name — so putting `--json`
 * on a group command like `clients` would swallow `clients list --json` before
 * the `list` action ever sees it (`opts.json` would be undefined). Attaching it
 * only to leaves keeps the flag bound to the command that reads it.
 *
 * Commands that render output through `writeOutput`/`shouldOutputJson` (which
 * walk the parent chain) honor the flag automatically; leaves that declare
 * their own `--json` are left untouched so their description and behavior win.
 */
export function registerGlobalJsonOption(program: Command): void {
  const walk = (cmd: Command): void => {
    const isLeaf = cmd.commands.length === 0;
    const alreadyDeclared = cmd.options.some((opt) => opt.long === JSON_FLAG);
    if (isLeaf && !alreadyDeclared) {
      cmd.option(JSON_FLAG, "Output machine-readable JSON");
    }
    for (const child of cmd.commands) {
      walk(child);
    }
  };
  for (const child of program.commands) {
    walk(child);
  }
}
