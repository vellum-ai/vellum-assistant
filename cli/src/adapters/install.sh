#!/bin/bash
set -euo pipefail

export HOME="${HOME:-$(eval echo ~"$(whoami)")}"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
RESET='\033[0m'

info() { printf "${BLUE}${BOLD}==>${RESET} ${BOLD}%s${RESET}\n" "$1"; }
success() { printf "${GREEN}${BOLD}==>${RESET} ${BOLD}%s${RESET}\n" "$1"; }
error() { printf "${RED}error:${RESET} %s\n" "$1" >&2; }

ensure_git() {
    # On macOS, /usr/bin/git is a shim that triggers an "Install Command Line
    # Developer Tools" popup instead of running git. Check that git actually
    # works, not just that the binary exists.
    if command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; then
        success "git already installed ($(git --version))"
        return
    fi

    info "Installing git..."
    if [ "$(uname -s)" = "Darwin" ]; then
        if command -v brew >/dev/null 2>&1; then
            brew install git
        else
            error "git is required. Install Homebrew (https://brew.sh) then run: brew install git"
            exit 1
        fi
    elif command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -qq && sudo apt-get install -y -qq git
    elif command -v yum >/dev/null 2>&1; then
        sudo yum install -y git
    elif command -v apk >/dev/null 2>&1; then
        sudo apk add git
    else
        error "git is required but could not be installed automatically. Please install it manually."
        exit 1
    fi

    # Clear bash's command hash so it finds the newly installed git binary
    # instead of the cached path to the macOS /usr/bin/git shim.
    hash -r 2>/dev/null || true

    if ! git --version >/dev/null 2>&1; then
        error "git installation failed. Please install manually."
        exit 1
    fi

    success "git installed ($(git --version))"
}

ensure_bun() {
    if command -v bun >/dev/null 2>&1; then
        success "bun already installed ($(bun --version))"
        return
    fi

    if [ -x "$HOME/.bun/bin/bun" ]; then
        export BUN_INSTALL="$HOME/.bun"
        export PATH="$BUN_INSTALL/bin:$PATH"
        success "bun found at ~/.bun/bin/bun ($(bun --version))"
        return
    fi

    if ! command -v unzip >/dev/null 2>&1; then
        info "Installing unzip (required by bun)..."
        if command -v apt-get >/dev/null 2>&1; then
            sudo apt-get update -qq && sudo apt-get install -y -qq unzip
        elif command -v yum >/dev/null 2>&1; then
            sudo yum install -y unzip
        elif command -v apk >/dev/null 2>&1; then
            sudo apk add unzip
        else
            error "unzip is required but could not be installed automatically. Please install it manually."
            exit 1
        fi
    fi

    info "Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"

    if ! command -v bun >/dev/null 2>&1; then
        error "bun installation failed. Please install manually: https://bun.sh"
        exit 1
    fi

    success "bun installed ($(bun --version))"
}

# Ensure ~/.bun/bin is in the user's shell profile so bun and vellum are
# available in new terminal sessions. The bun installer sometimes skips
# this (e.g. when stdin is piped via curl | bash).
configure_shell_profile() {
    local bun_line='export BUN_INSTALL="$HOME/.bun"'
    local path_line='export PATH="$BUN_INSTALL/bin:$PATH"'
    local snippet
    snippet=$(printf '\n# bun\n%s\n%s\n' "$bun_line" "$path_line")

    local profiles=()
    local shell_name="${SHELL:-}"

    if [[ "$shell_name" == */zsh ]]; then
        profiles+=("$HOME/.zshrc")
    elif [[ "$shell_name" == */bash ]]; then
        # Write to both .bashrc (non-login shells, e.g. new terminal on Linux)
        # and .bash_profile (login shells, e.g. macOS Terminal.app)
        profiles+=("$HOME/.bashrc")
        [ -f "$HOME/.bash_profile" ] && profiles+=("$HOME/.bash_profile")
    else
        # Unknown shell — try both
        profiles+=("$HOME/.bashrc")
        [ -f "$HOME/.zshrc" ] && profiles+=("$HOME/.zshrc")
    fi

    for profile in "${profiles[@]}"; do
        if [ -f "$profile" ] && grep -q 'BUN_INSTALL' "$profile" 2>/dev/null; then
            continue
        fi
        printf '%s\n' "$snippet" >> "$profile"
        success "Added bun to PATH in $profile"
    done
}

# Create a symlink so `vellum` is available without ~/.bun/bin in PATH.
# Tries /usr/local/bin first (works on most systems), falls back to
# ~/.local/bin (user-writable, no sudo needed).
# This is best-effort — failure must not abort the install script.
symlink_vellum() {
    local vellum_bin="$HOME/.bun/bin/vellum"
    if [ ! -f "$vellum_bin" ]; then
        return 0
    fi

    # Skip if vellum is already resolvable outside of ~/.bun/bin
    local resolved
    resolved=$(command -v vellum 2>/dev/null || true)
    if [ -n "$resolved" ] && [ "$resolved" != "$vellum_bin" ]; then
        return 0
    fi

    # Try /usr/local/bin (may need sudo on some systems)
    if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
        if ln -sf "$vellum_bin" /usr/local/bin/vellum 2>/dev/null; then
            success "Symlinked /usr/local/bin/vellum → $vellum_bin"
            return 0
        fi
    fi

    # Fallback: ~/.local/bin
    local local_bin="$HOME/.local/bin"
    mkdir -p "$local_bin" 2>/dev/null || true
    if ln -sf "$vellum_bin" "$local_bin/vellum" 2>/dev/null; then
        success "Symlinked $local_bin/vellum → $vellum_bin"
        # Ensure ~/.local/bin is in PATH in shell profile
        for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
            if [ -f "$profile" ] && ! grep -q "$local_bin" "$profile" 2>/dev/null; then
                printf '\nexport PATH="%s:$PATH"\n' "$local_bin" >> "$profile"
            fi
        done
        return 0
    fi

    return 0
}

# Write a small sourceable env file to ~/.config/vellum/env so callers can
# pick up PATH changes without restarting their shell:
#   curl -fsSL https://assistant.vellum.ai/install.sh | bash && . ~/.config/vellum/env
write_env_file() {
    local env_dir="${XDG_CONFIG_HOME:-$HOME/.config}/vellum"
    local env_file="$env_dir/env"
    mkdir -p "$env_dir"
    cat > "$env_file" <<'ENVEOF'
export BUN_INSTALL="$HOME/.bun"
case ":$PATH:" in
  *":$BUN_INSTALL/bin:"*) ;;
  *) export PATH="$BUN_INSTALL/bin:$PATH" ;;
esac
ENVEOF
}

install_completions() {
    info "Installing shell completions for vellum"

    local COMP_DIR="${HOME}/.config/vellum/completions"
    mkdir -p "${COMP_DIR}"

    local LOCKFILE_PATH="${HOME}/.vellum.lock.json"
    local LOCKFILE_GREP="grep -o '\"assistantId\"[[:space:]]*:[[:space:]]*\"[^\"]*\"' ${LOCKFILE_PATH} 2>/dev/null | awk -F'\"' '{print \$(NF-1)}'"

    # — Bash completions —
    cat > "${COMP_DIR}/completions.bash" << 'BASH_COMP'
_vellum_completions() {
  local cur prev commands
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  commands="audit autonomy client config contacts daemon dev doctor email hatch hooks keys login logout memory pair ps recover retire sessions skills sleep ssh trust wake whoami"

  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands} --help --version" -- "${cur}") )
    return 0
  fi

  case "${COMP_WORDS[1]}" in
    autonomy)
      COMPREPLY=( $(compgen -W "get set" -- "${cur}") )
      ;;
    config)
      COMPREPLY=( $(compgen -W "set get list validate-allowlist" -- "${cur}") )
      ;;
    contacts)
      COMPREPLY=( $(compgen -W "list get merge" -- "${cur}") )
      ;;
    daemon)
      COMPREPLY=( $(compgen -W "start stop restart status" -- "${cur}") )
      ;;
    hatch)
      COMPREPLY=( $(compgen -W "--name --daemon-only -d" -- "${cur}") )
      ;;
    hooks)
      COMPREPLY=( $(compgen -W "list enable disable install remove" -- "${cur}") )
      ;;
    keys)
      COMPREPLY=( $(compgen -W "list set delete" -- "${cur}") )
      ;;
    memory)
      COMPREPLY=( $(compgen -W "status backfill cleanup query rebuild-index" -- "${cur}") )
      ;;
    sessions)
      COMPREPLY=( $(compgen -W "list new export clear" -- "${cur}") )
      ;;
    trust)
      COMPREPLY=( $(compgen -W "list remove clear" -- "${cur}") )
      ;;
    client|retire)
BASH_COMP

    # Append the dynamic lockfile lookup (needs variable expansion).
    # Use a while-read loop instead of compgen -W to avoid shell expansion
    # on lockfile values (prevents command injection via crafted assistant IDs).
    cat >> "${COMP_DIR}/completions.bash" << BASH_COMP_DYN
      while IFS= read -r _vellum_id; do
        [[ -n "\$_vellum_id" && "\$_vellum_id" == "\${cur}"* ]] && COMPREPLY+=("\$_vellum_id")
      done < <(${LOCKFILE_GREP})
BASH_COMP_DYN

    cat >> "${COMP_DIR}/completions.bash" << 'BASH_COMP_END'
      ;;
  esac

  return 0
}

complete -F _vellum_completions vellum
BASH_COMP_END

    # — Zsh completions —
    cat > "${COMP_DIR}/completions.zsh" << 'ZSH_COMP'
_vellum() {
  local -a commands
  commands=(
    'audit:Show recent tool invocations'
    'autonomy:View and configure autonomy tiers'
    'client:Connect to a hatched assistant'
    'config:Manage configuration'
    'contacts:Manage the contact graph'
    'daemon:Manage the daemon process'
    'dev:Run daemon in dev mode with auto-restart'
    'doctor:Run diagnostic checks'
    'email:Email operations'
    'hatch:Create a new assistant instance'
    'hooks:Manage hooks'
    'keys:Manage API keys in secure storage'
    'login:Log in to the Vellum platform'
    'logout:Log out of the Vellum platform'
    'memory:Manage long-term memory'
    'pair:Pair with a remote assistant via QR code'
    'ps:List assistants'
    'recover:Restore a previously retired assistant'
    'retire:Delete an assistant instance'
    'sessions:Manage sessions'
    'skills:Browse and install skills'
    'sleep:Stop the daemon process'
    'ssh:SSH into a remote assistant instance'
    'trust:Manage trust rules'
    'wake:Start the daemon and gateway'
    'whoami:Show current logged-in user'
  )

  _arguments -C \
    '1:command:->command' \
    '*::arg:->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        autonomy)
          _arguments '*:subcommand:(get set)'
          ;;
        config)
          _arguments '*:subcommand:(set get list validate-allowlist)'
          ;;
        contacts)
          _arguments '*:subcommand:(list get merge)'
          ;;
        daemon)
          _arguments '*:subcommand:(start stop restart status)'
          ;;
        hatch)
          _arguments '*:option:(--name --daemon-only -d)'
          ;;
        hooks)
          _arguments '*:subcommand:(list enable disable install remove)'
          ;;
        keys)
          _arguments '*:subcommand:(list set delete)'
          ;;
        memory)
          _arguments '*:subcommand:(status backfill cleanup query rebuild-index)'
          ;;
        sessions)
          _arguments '*:subcommand:(list new export clear)'
          ;;
        trust)
          _arguments '*:subcommand:(list remove clear)'
          ;;
        client|retire)
          local -a instances
ZSH_COMP

    # Append the dynamic lockfile lookup (needs variable expansion)
    cat >> "${COMP_DIR}/completions.zsh" << ZSH_COMP_DYN
          instances=(\${(f)"\$(${LOCKFILE_GREP})"})
ZSH_COMP_DYN

    cat >> "${COMP_DIR}/completions.zsh" << 'ZSH_COMP_END'
          _describe 'instance' instances
          ;;
      esac
      ;;
  esac
}

compdef _vellum vellum
ZSH_COMP_END

    # — Fish completions —
    local FISH_COMP_DIR="${HOME}/.config/fish/completions"
    mkdir -p "${FISH_COMP_DIR}"

    cat > "${FISH_COMP_DIR}/vellum.fish" << 'FISH_COMP'
# vellum fish completion
complete -c vellum -f
complete -c vellum -n '__fish_use_subcommand' -a 'audit' -d 'Show recent tool invocations'
complete -c vellum -n '__fish_use_subcommand' -a 'autonomy' -d 'View and configure autonomy tiers'
complete -c vellum -n '__fish_use_subcommand' -a 'client' -d 'Connect to a hatched assistant'
complete -c vellum -n '__fish_use_subcommand' -a 'config' -d 'Manage configuration'
complete -c vellum -n '__fish_use_subcommand' -a 'contacts' -d 'Manage the contact graph'
complete -c vellum -n '__fish_use_subcommand' -a 'daemon' -d 'Manage the daemon process'
complete -c vellum -n '__fish_use_subcommand' -a 'dev' -d 'Run daemon in dev mode with auto-restart'
complete -c vellum -n '__fish_use_subcommand' -a 'doctor' -d 'Run diagnostic checks'
complete -c vellum -n '__fish_use_subcommand' -a 'email' -d 'Email operations'
complete -c vellum -n '__fish_use_subcommand' -a 'hatch' -d 'Create a new assistant instance'
complete -c vellum -n '__fish_use_subcommand' -a 'hooks' -d 'Manage hooks'
complete -c vellum -n '__fish_use_subcommand' -a 'keys' -d 'Manage API keys in secure storage'
complete -c vellum -n '__fish_use_subcommand' -a 'login' -d 'Log in to the Vellum platform'
complete -c vellum -n '__fish_use_subcommand' -a 'logout' -d 'Log out of the Vellum platform'
complete -c vellum -n '__fish_use_subcommand' -a 'memory' -d 'Manage long-term memory'
complete -c vellum -n '__fish_use_subcommand' -a 'pair' -d 'Pair with a remote assistant via QR code'
complete -c vellum -n '__fish_use_subcommand' -a 'ps' -d 'List assistants'
complete -c vellum -n '__fish_use_subcommand' -a 'recover' -d 'Restore a previously retired assistant'
complete -c vellum -n '__fish_use_subcommand' -a 'retire' -d 'Delete an assistant instance'
complete -c vellum -n '__fish_use_subcommand' -a 'sessions' -d 'Manage sessions'
complete -c vellum -n '__fish_use_subcommand' -a 'skills' -d 'Browse and install skills'
complete -c vellum -n '__fish_use_subcommand' -a 'sleep' -d 'Stop the daemon process'
complete -c vellum -n '__fish_use_subcommand' -a 'ssh' -d 'SSH into a remote assistant instance'
complete -c vellum -n '__fish_use_subcommand' -a 'trust' -d 'Manage trust rules'
complete -c vellum -n '__fish_use_subcommand' -a 'wake' -d 'Start the daemon and gateway'
complete -c vellum -n '__fish_use_subcommand' -a 'whoami' -d 'Show current logged-in user'
complete -c vellum -n '__fish_use_subcommand' -l help -d 'Show help'
complete -c vellum -n '__fish_use_subcommand' -l version -d 'Show version'
complete -c vellum -n '__fish_seen_subcommand_from autonomy' -a 'get set'
complete -c vellum -n '__fish_seen_subcommand_from config' -a 'set get list validate-allowlist'
complete -c vellum -n '__fish_seen_subcommand_from contacts' -a 'list get merge'
complete -c vellum -n '__fish_seen_subcommand_from daemon' -a 'start stop restart status'
complete -c vellum -n '__fish_seen_subcommand_from hooks' -a 'list enable disable install remove'
complete -c vellum -n '__fish_seen_subcommand_from keys' -a 'list set delete'
complete -c vellum -n '__fish_seen_subcommand_from memory' -a 'status backfill cleanup query rebuild-index'
complete -c vellum -n '__fish_seen_subcommand_from sessions' -a 'list new export clear'
complete -c vellum -n '__fish_seen_subcommand_from trust' -a 'list remove clear'
FISH_COMP

    # — Source completions from shell rc files —
    if [ -f "${HOME}/.bashrc" ]; then
        if ! grep -q '.config/vellum/completions/completions.bash' "${HOME}/.bashrc"; then
            printf '\n# vellum completions\nsource ~/.config/vellum/completions/completions.bash\n' >> "${HOME}/.bashrc"
        fi
    fi

    if [ -f "${HOME}/.zshrc" ]; then
        if ! grep -q '.config/vellum/completions/completions.zsh' "${HOME}/.zshrc"; then
            printf '\n# vellum completions\nsource ~/.config/vellum/completions/completions.zsh\n' >> "${HOME}/.zshrc"
        fi
    fi

    success "Shell completions installed"
}

install_vellum() {
    if command -v vellum >/dev/null 2>&1; then
        info "Updating vellum to latest..."
        bun install -g vellum@latest
    else
        info "Installing vellum globally..."
        bun install -g vellum@latest
    fi

    if ! command -v vellum >/dev/null 2>&1; then
        error "vellum installation failed. Please install manually: bun install -g vellum"
        exit 1
    fi

    success "vellum installed ($(vellum --version 2>/dev/null || echo 'unknown'))"
}

main() {
    printf "\n"
    printf '  %bVellum Installer%b\n' "$BOLD" "$RESET"
    printf "\n"

    ensure_git
    ensure_bun
    configure_shell_profile
    install_vellum
    symlink_vellum
    install_completions

    # Write a sourceable env file so the quickstart one-liner can pick up
    # PATH changes in the caller's shell:
    #   curl ... | bash && . ~/.config/vellum/env
    write_env_file

    # Source the shell profile so vellum hatch runs with the correct PATH
    # in this session (the profile changes only take effect in new shells
    # otherwise).
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"

    info "Running vellum hatch..."
    printf "\n"
    if [ -n "${VELLUM_SSH_USER:-}" ] && [ "$(id -u)" = "0" ]; then
        su - "$VELLUM_SSH_USER" -c "set -a; [ -f \"\$HOME/.vellum/.env\" ] && . \"\$HOME/.vellum/.env\"; set +a; export PATH=\"$HOME/.bun/bin:\$PATH\"; vellum hatch"
    else
        vellum hatch
    fi
}

main "$@"
