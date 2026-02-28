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
    if command -v git >/dev/null 2>&1; then
        success "git already installed ($(git --version))"
        return
    fi

    info "Installing git..."
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -qq && sudo apt-get install -y -qq git
    elif command -v yum >/dev/null 2>&1; then
        sudo yum install -y git
    elif command -v apk >/dev/null 2>&1; then
        sudo apk add git
    else
        error "git is required but could not be installed automatically. Please install it manually."
        exit 1
    fi

    if ! command -v git >/dev/null 2>&1; then
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
        # On macOS, login shells read .bash_profile; on Linux, .bashrc
        if [ -f "$HOME/.bash_profile" ]; then
            profiles+=("$HOME/.bash_profile")
        else
            profiles+=("$HOME/.bashrc")
        fi
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
symlink_vellum() {
    local vellum_bin="$HOME/.bun/bin/vellum"
    if [ ! -f "$vellum_bin" ]; then
        return
    fi

    # Skip if vellum is already resolvable outside of ~/.bun/bin
    local resolved
    resolved=$(command -v vellum 2>/dev/null || true)
    if [ -n "$resolved" ] && [ "$resolved" != "$vellum_bin" ]; then
        return
    fi

    # Try /usr/local/bin (may need sudo on some systems)
    if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
        ln -sf "$vellum_bin" /usr/local/bin/vellum 2>/dev/null && {
            success "Symlinked /usr/local/bin/vellum → $vellum_bin"
            return
        }
    fi

    # Fallback: ~/.local/bin
    local local_bin="$HOME/.local/bin"
    mkdir -p "$local_bin"
    ln -sf "$vellum_bin" "$local_bin/vellum" 2>/dev/null && {
        success "Symlinked $local_bin/vellum → $vellum_bin"
        # Ensure ~/.local/bin is in PATH in shell profile
        for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
            if [ -f "$profile" ] && ! grep -q "$local_bin" "$profile" 2>/dev/null; then
                printf '\nexport PATH="%s:$PATH"\n' "$local_bin" >> "$profile"
            fi
        done
        return
    }
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

    info "Running vellum hatch..."
    printf "\n"
    if [ -n "${VELLUM_SSH_USER:-}" ] && [ "$(id -u)" = "0" ]; then
        su - "$VELLUM_SSH_USER" -c "set -a; [ -f \"\$HOME/.vellum/.env\" ] && . \"\$HOME/.vellum/.env\"; set +a; export PATH=\"$HOME/.bun/bin:\$PATH\"; vellum hatch"
    else
        vellum hatch
    fi
}

main "$@"
