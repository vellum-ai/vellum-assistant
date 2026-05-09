import type { Command } from "commander";

export type CommandTransport = "ipc" | "local" | "bootstrap";

interface RegisterCommandOpts {
  name: string;
  transport: CommandTransport;
  description: string;
  build: (cmd: Command) => void;
}

export function registerCommand(
  parent: Command,
  opts: RegisterCommandOpts,
): Command {
  const cmd = parent.command(opts.name).description(opts.description);
  opts.build(cmd);
  return cmd;
}
