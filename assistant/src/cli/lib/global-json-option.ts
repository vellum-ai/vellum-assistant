import type { Command } from "commander";

const JSON_FLAG = "--json";

/**
 * Register a `--json` option on every subcommand in the tree that does not
 * already declare one.
 *
 * Commander only recognizes an option at the position of the command it is
 * attached to, so a single option on the root program would still reject
 * `assistant status --json` with "unknown option '--json'". Attaching `--json`
 * to each command makes the flag accepted everywhere, which is what callers
 * (and agents) expect when they append `--json` to any command.
 *
 * Commands that render output through `writeOutput`/`shouldOutputJson` (which
 * walk the parent chain) honor the flag automatically; commands that declare
 * their own `--json` are left untouched so their description and behavior win.
 */
export function registerGlobalJsonOption(program: Command): void {
  const walk = (cmd: Command): void => {
    const alreadyDeclared = cmd.options.some((opt) => opt.long === JSON_FLAG);
    if (!alreadyDeclared) {
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
