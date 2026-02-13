#!/bin/bash
set -euo pipefail

REPO="vellum-ai/vellum-assistant"
INSTALL_DIR="${VELLUM_INSTALL_DIR:-$HOME/.vellum/bin}"
BASE_URL="https://github.com/${REPO}/releases/latest/download"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

info() { printf "${BLUE}${BOLD}==>${RESET} ${BOLD}%s${RESET}\n" "$1"; }
success() { printf "${GREEN}${BOLD}==>${RESET} ${BOLD}%s${RESET}\n" "$1"; }
warn() { printf "${YELLOW}warning:${RESET} %s\n" "$1" >&2; }
error() { printf "${RED}error:${RESET} %s\n" "$1" >&2; }

detect_platform() {
    local os arch

    case "$(uname -s)" in
        Darwin) os="darwin" ;;
        Linux)  os="linux" ;;
        *)
            error "Unsupported operating system: $(uname -s)"
            error "Vellum currently supports macOS and Linux."
            exit 1
            ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64)  arch="x64" ;;
        arm64|aarch64) arch="arm64" ;;
        *)
            error "Unsupported architecture: $(uname -m)"
            exit 1
            ;;
    esac

    PLATFORM="${os}"
    ARCH="${arch}"
    ASSET_NAME="vellum-${PLATFORM}-${ARCH}.tar.gz"
}

download() {
    local url="$1" dest="$2"

    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 "$url" -o "$dest"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$dest" "$url"
    else
        error "Neither curl nor wget found. Please install one and try again."
        exit 1
    fi
}

install_binary() {
    local tmp_dir
    tmp_dir="$(mktemp -d)"
    trap 'rm -rf "$tmp_dir"' EXIT

    local url="${BASE_URL}/${ASSET_NAME}"
    info "Downloading vellum for ${PLATFORM}-${ARCH}..."
    printf "  ${DIM}%s${RESET}\n" "$url"

    if ! download "$url" "$tmp_dir/vellum.tar.gz"; then
        error "Download failed."
        error "This may mean there is no release for ${PLATFORM}-${ARCH} yet."
        error "Check ${REPO} for available releases."
        exit 1
    fi

    info "Extracting..."
    tar -xzf "$tmp_dir/vellum.tar.gz" -C "$tmp_dir"

    if [ ! -f "$tmp_dir/vellum" ]; then
        error "Archive did not contain a 'vellum' binary."
        exit 1
    fi

    mkdir -p "$INSTALL_DIR"
    mv "$tmp_dir/vellum" "$INSTALL_DIR/vellum"
    chmod +x "$INSTALL_DIR/vellum"
}

update_shell_profile() {
    local export_line="export PATH=\"${INSTALL_DIR}:\$PATH\""

    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*)
            return
            ;;
    esac

    local updated=false
    for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
        if [ -f "$profile" ]; then
            if ! grep -qF "$INSTALL_DIR" "$profile" 2>/dev/null; then
                printf '\n# Vellum\n%s\n' "$export_line" >> "$profile"
                updated=true
            fi
        fi
    done

    if [ "$updated" = false ]; then
        if [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "zsh" ]; then
            printf '\n# Vellum\n%s\n' "$export_line" >> "$HOME/.zshrc"
        else
            printf '\n# Vellum\n%s\n' "$export_line" >> "$HOME/.bashrc"
        fi
    fi

    export PATH="${INSTALL_DIR}:${PATH}"
}

print_success() {
    local version
    version="$("$INSTALL_DIR/vellum" --version 2>/dev/null || echo "unknown")"

    printf "\n"
    success "Vellum ${version} installed to ${INSTALL_DIR}/vellum"
    printf "\n"

    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*)
            printf '  Run %bvellum%b to get started.\n' "$BOLD" "$RESET"
            ;;
        *)
            printf '  Restart your shell, then run %bvellum%b to get started.\n' "$BOLD" "$RESET"
            ;;
    esac

    printf "\n"
}

main() {
    printf "\n"
    printf '  %bVellum Installer%b\n' "$BOLD" "$RESET"
    printf "\n"

    detect_platform
    install_binary
    update_shell_profile
    print_success
}

main "$@"
