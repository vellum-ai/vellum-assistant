import type { Command } from "commander";

import { getCliLogger } from "../../util/logger.js";

const log = getCliLogger("cli");

export function registerCompletionsCommand(program: Command): void {
  program
    .command("completions")
    .argument("<shell>", "Shell type: bash, zsh, or fish")
    .description(
      "Generate shell completion script (e.g. assistant completions bash >> ~/.bashrc)",
    )
    .addHelpText(
      "after",
      `
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
    )
    .action((shell: string) => {
      const subcommands: Record<string, string[]> = {
        sessions: ["list", "new", "export", "clear"],
        config: ["set", "get", "list", "validate-allowlist"],
        keys: ["list", "set", "delete"],
        trust: ["list", "remove", "clear"],
        memory: ["status", "backfill", "cleanup", "query", "rebuild-index"],
        hooks: ["list", "enable", "disable", "install", "remove"],
        contacts: ["list", "invites", "get", "merge"],
        autonomy: ["get", "set"],
      };
      const topLevel = [
        "dev",
        "sessions",
        "config",
        "keys",
        "trust",
        "memory",
        "hooks",
        "contacts",
        "autonomy",
        "audit",
        "doctor",
        "completions",
        "help",
      ];

      switch (shell) {
        case "bash":
          process.stdout.write(generateBashCompletion(topLevel, subcommands));
          break;
        case "zsh":
          process.stdout.write(generateZshCompletion(topLevel, subcommands));
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

function generateZshCompletion(
  topLevel: string[],
  subcommands: Record<string, string[]>,
): string {
  const subcmdCases = Object.entries(subcommands)
    .map(([cmd, subs]) => `        ${cmd}) compadd ${subs.join(" ")} ;;`)
    .join("\n");

  return `#compdef assistant
# assistant zsh completion
# Add to ~/.zshrc: eval "$(assistant completions zsh)"
_assistant() {
    local -a commands
    commands=(
        'dev:Run assistant in dev mode with auto-restart'
        'sessions:Manage sessions'
        'config:Manage configuration'
        'keys:Manage API keys in secure storage'
        'trust:Manage trust rules'
        'memory:Manage long-term memory'
        'hooks:Manage hooks'
        'contacts:Manage the contact graph'
        'autonomy:View and configure autonomy tiers'
        'audit:Show recent tool invocations'
        'doctor:Run diagnostic checks'
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
    dev: "Run assistant in dev mode with auto-restart",
    sessions: "Manage sessions",
    config: "Manage configuration",
    keys: "Manage API keys in secure storage",
    trust: "Manage trust rules",
    memory: "Manage long-term memory",
    hooks: "Manage hooks",
    contacts: "Manage the contact graph",
    autonomy: "View and configure autonomy tiers",
    audit: "Show recent tool invocations",
    doctor: "Run diagnostic checks",
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
