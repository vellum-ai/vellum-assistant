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
        # On macOS, the standard way to get git is via Xcode Command Line Tools.
        # Try installing CLT first before falling back to Homebrew.
        if ! xcode-select -p >/dev/null 2>&1; then
            info "Installing Xcode Command Line Tools (includes git)..."

            # Use softwareupdate to install CLT non-interactively instead of
            # xcode-select --install which opens a GUI dialog requiring manual
            # confirmation.
            touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
            local clt_package
            # softwareupdate -l output has two relevant lines per update:
            #   * Label: Command Line Tools for Xcode-16.0       <-- label (what -i expects)
            #       Title: Command Line Tools for Xcode, ...      <-- description
            # We need the label, which is on lines starting with "* ".
            # Use the same parsing approach as Homebrew's installer.
            clt_package=$(softwareupdate -l 2>/dev/null \
                | grep -B 1 -E 'Command Line Tools' \
                | awk -F'*' '/^\*/{print $2}' \
                | sed -e 's/^ Label: //' -e 's/^ *//' \
                | sort -V \
                | tail -1)

            if [ -n "$clt_package" ]; then
                info "Found package: $clt_package"
                softwareupdate -i "$clt_package" --verbose 2>&1 | while IFS= read -r line; do
                    printf "  %s\n" "$line"
                done
            else
                # Fallback: if softwareupdate can't find the package, try
                # xcode-select --install and wait for user interaction.
                info "Could not find CLT package via softwareupdate, falling back to xcode-select..."
                xcode-select --install 2>/dev/null || true
                info "Please follow the on-screen dialog to install. Waiting..."
                local waited=0
                while ! xcode-select -p >/dev/null 2>&1; do
                    sleep 5
                    waited=$((waited + 5))
                    if [ "$waited" -ge 600 ]; then
                        error "Timed out waiting for Xcode Command Line Tools. Please install manually and re-run."
                        exit 1
                    fi
                done
            fi

            rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
            hash -r 2>/dev/null || true
        fi

        # If git still doesn't work after CLT, try Homebrew as a fallback.
        if ! git --version >/dev/null 2>&1; then
            hash -r 2>/dev/null || true
            if command -v brew >/dev/null 2>&1; then
                brew install git
            else
                error "git is still not available. Please install manually: xcode-select --install"
                exit 1
            fi
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

# Ensure ~/.bun/bin is in the user's shell profile so bun and assistant are
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

# Create a symlink so `assistant` is available without ~/.bun/bin in PATH.
# Tries /usr/local/bin first (works on most systems), falls back to
# ~/.local/bin (user-writable, no sudo needed).
# This is best-effort — failure must not abort the install script.
symlink_assistant() {
    local assistant_bin="$HOME/.bun/bin/assistant"
    if [ ! -f "$assistant_bin" ]; then
        return 0
    fi

    # Skip if assistant is already resolvable outside of ~/.bun/bin
    local resolved
    resolved=$(command -v assistant 2>/dev/null || true)
    if [ -n "$resolved" ] && [ "$resolved" != "$assistant_bin" ]; then
        return 0
    fi

    # Try /usr/local/bin (may need sudo on some systems)
    if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
        if ln -sf "$assistant_bin" /usr/local/bin/assistant 2>/dev/null; then
            success "Symlinked /usr/local/bin/assistant → $assistant_bin"
            return 0
        fi
    fi

    # Fallback: ~/.local/bin
    local local_bin="$HOME/.local/bin"
    mkdir -p "$local_bin" 2>/dev/null || true
    if ln -sf "$assistant_bin" "$local_bin/assistant" 2>/dev/null; then
        success "Symlinked $local_bin/assistant → $assistant_bin"
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

install_assistant() {
    if command -v assistant >/dev/null 2>&1; then
        info "Updating assistant CLI to latest..."
        bun install -g vellum@latest
    else
        info "Installing assistant CLI globally..."
        bun install -g vellum@latest
    fi

    if ! command -v assistant >/dev/null 2>&1; then
        error "assistant CLI installation failed. Please install manually: bun install -g vellum"
        exit 1
    fi

    success "assistant CLI installed ($(assistant --version 2>/dev/null || echo 'unknown'))"
}

main() {
    printf "\n"
    printf '  %bVellum Installer%b\n' "$BOLD" "$RESET"
    printf "\n"

    ensure_git
    ensure_bun
    configure_shell_profile
    install_assistant
    symlink_assistant

    # Write a sourceable env file so the quickstart one-liner can pick up
    # PATH changes in the caller's shell:
    #   curl ... | bash && . ~/.config/vellum/env
    write_env_file

    # Source the shell profile so assistant hatch runs with the correct PATH
    # in this session (the profile changes only take effect in new shells
    # otherwise).
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"

    info "Running assistant hatch..."
    printf "\n"
    if [ -n "${VELLUM_SSH_USER:-}" ] && [ "$(id -u)" = "0" ]; then
        su - "$VELLUM_SSH_USER" -c "set -a; [ -f \"\$HOME/.vellum/.env\" ] && . \"\$HOME/.vellum/.env\"; set +a; export PATH=\"$HOME/.bun/bin:\$PATH\"; assistant hatch"
    else
        assistant hatch
    fi
}

main "$@"
