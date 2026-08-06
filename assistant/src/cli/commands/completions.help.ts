/** Declarative help for the `assistant completions` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const completionsHelp: CliCommandHelp = {
  name: "completions",
  description:
    "Generate shell completion script (e.g. assistant completions bash >> ~/.bashrc)",
  arguments: [
    { name: "<shell>", description: "Shell type: bash, zsh, or fish" },
  ],
  helpText: `
Arguments:
  shell   Shell to generate completions for: bash, zsh, or fish

Generates a completion script that enables tab-completion for common assistant
commands, subcommands, and flags. The script is written to stdout so you
can redirect it to a file or eval it directly.

Installation per shell:
  bash   Append to ~/.bashrc or eval in your shell profile:
           eval "$(assistant completions bash)"
  zsh    Append to ~/.zshrc or eval in your shell profile:
           eval "$(assistant completions zsh)"
  fish   Pipe to source or save to the fish completions directory:
           assistant completions fish | source
           assistant completions fish > ~/.config/fish/completions/assistant.fish

Examples:
  $ assistant completions bash >> ~/.bashrc
  $ eval "$(assistant completions zsh)"
  $ assistant completions fish | source`,
};
