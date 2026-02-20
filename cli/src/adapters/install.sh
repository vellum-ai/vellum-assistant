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

main() {
    printf "\n"
    printf '  %bVellum Installer%b\n' "$BOLD" "$RESET"
    printf "\n"

    ensure_git
    ensure_bun

    info "Running vellum hatch..."
    printf "\n"
    if [ -n "${VELLUM_SSH_USER:-}" ] && [ "$(id -u)" = "0" ]; then
        su - "$VELLUM_SSH_USER" -c "set -a; [ -f \"\$HOME/.vellum/.env\" ] && . \"\$HOME/.vellum/.env\"; set +a; export PATH=\"$HOME/.bun/bin:\$PATH\"; bunx vellum hatch"
    else
        bunx vellum hatch
    fi
}

main "$@"
