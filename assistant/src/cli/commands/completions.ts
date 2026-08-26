import type { Command } from "commander";

import { applyCommandHelp } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { completionsHelp } from "./completions.help.js";

export function registerCompletionsCommand(program: Command): void {
  registerCommand(program, {
    name: completionsHelp.name,
    transport: "local",
    description: completionsHelp.description,
    build: (cmd) => {
      applyCommandHelp(cmd, completionsHelp);
      cmd.action((shell: string) => {
        const subcommands: Record<string, string[]> = {
          conversations: ["list", "new", "export", "clear"],
          config: ["set", "get", "list", "validate-allowlist"],
          keys: ["list", "set", "delete"],
          trust: ["list"],
          memory: ["status", "backfill", "cleanup", "query", "rebuild-index"],
          contacts: ["list", "invites", "get", "merge"],
        };
        const topLevel = [
          "conversations",
          "config",
          "keys",
          "trust",
          "memory",
          "contacts",
          "audit",
          "completions",
          "help",
        ];

        switch (shell) {
          case "bash":
            process.stdout.write(generateBashCompletion(topLevel, subcommands));
            break;
          case "zsh":
            process.stdout.write(generateZshCompletion(subcommands));
            break;
          case "fish":
            process.stdout.write(generateFishCompletion(topLevel, subcommands));
            break;
          default:
            log.error(
              `Unknown shell: ${shell}. Supported shells: bash, zsh, fish`,
            );
            process.exit(1);
        }
      });
    },
  });
}

function generateBashCompletion(
  topLevel: string[],
  subcommands: Record<string, string[]>,
): string {
  const subcmdCases = Object.entries(subcommands)
    .map(
      ([cmd, subs]) =>
        `        ${cmd}) COMPREPLY=( $(compgen -W "${subs.join(
          " ",
        )}" -- "$cur") ) ;;`,
    )
    .join("\n");

  return `# assistant bash completion
# Add to ~/.bashrc: eval "$(assistant completions bash)"
_assistant_completions() {
    local cur prev words cword
    _init_completion || return

    if [[ $cword -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "${topLevel.join(
          " ",
        )} --help --version" -- "$cur") )
        return
    fi

    case "\${words[1]}" in
${subcmdCases}
        audit) COMPREPLY=( $(compgen -W "--limit -l" -- "$cur") ) ;;
        completions) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ) ;;
    esac
}
complete -F _assistant_completions assistant
`;
}

function generateZshCompletion(subcommands: Record<string, string[]>): string {
  const subcmdCases = Object.entries(subcommands)
    .map(([cmd, subs]) => `        ${cmd}) compadd ${subs.join(" ")} ;;`)
    .join("\n");

  return `#compdef assistant
# assistant zsh completion
# Add to ~/.zshrc: eval "$(assistant completions zsh)"
_assistant() {
    local -a commands
    commands=(
        'conversations:Manage conversations'
        'config:Manage configuration'
        'keys:Manage API keys in secure storage'
        'trust:View trust rules'
        'memory:Manage long-term memory'
        'contacts:Manage the contact graph'
        'audit:Show recent tool invocations'
        'completions:Generate shell completion script'
        'help:Display help'
    )

    if (( CURRENT == 2 )); then
        _describe 'command' commands
        _arguments '--help[Show help]' '--version[Show version]'
        return
    fi

    case "\${words[2]}" in
${subcmdCases}
        audit) _arguments '-l[Number of entries]' '--limit[Number of entries]' ;;
        completions) compadd bash zsh fish ;;
    esac
}
compdef _assistant assistant
`;
}

function generateFishCompletion(
  topLevel: string[],
  subcommands: Record<string, string[]>,
): string {
  let script = `# assistant fish completion
# Add to ~/.config/fish/completions/assistant.fish or eval: assistant completions fish | source
`;

  script += `complete -c assistant -f\n`;

  const descriptions: Record<string, string> = {
    conversations: "Manage conversations",
    config: "Manage configuration",
    keys: "Manage API keys in secure storage",
    trust: "View trust rules",
    memory: "Manage long-term memory",
    contacts: "Manage the contact graph",
    audit: "Show recent tool invocations",
    completions: "Generate shell completion script",
    help: "Display help",
  };

  for (const cmd of topLevel) {
    const desc = descriptions[cmd] ?? "";
    script += `complete -c assistant -n '__fish_use_subcommand' -a '${cmd}' -d '${desc}'\n`;
  }
  script += `complete -c assistant -n '__fish_use_subcommand' -l help -d 'Show help'\n`;
  script += `complete -c assistant -n '__fish_use_subcommand' -l version -d 'Show version'\n`;

  for (const [cmd, subs] of Object.entries(subcommands)) {
    for (const sub of subs) {
      script += `complete -c assistant -n '__fish_seen_subcommand_from ${cmd}' -a '${sub}'\n`;
    }
  }

  script += `complete -c assistant -n '__fish_seen_subcommand_from audit' -s l -l limit -d 'Number of entries'\n`;
  script += `complete -c assistant -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish'\n`;

  return script;
}
