#!/usr/bin/env bash
#
# setup.sh — One-time local development setup for vellum-assistant.
#
# Installs dependencies for each package, registers local packages as
# linkable, links them into the meta package, and then links the global
# `vellum` command to the local meta entry point.
#
# Usage:
#   ./setup.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

info()  { echo "==> $*"; }
error() { echo "error: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Pre-flight: ensure bun is available (install automatically if missing)
# ---------------------------------------------------------------------------
# Keep this version in sync with .tool-versions (bun).
EXPECTED_BUN_VERSION="1.3.11"

if ! command -v bun &>/dev/null; then
  info "Bun not found — installing bun-v${EXPECTED_BUN_VERSION} from https://bun.sh"
  curl -fsSL https://bun.sh/install | bash -s "bun-v${EXPECTED_BUN_VERSION}"
  # Add bun to PATH for the rest of this script
  export BUN_INSTALL="${HOME}/.bun"
  export PATH="${BUN_INSTALL}/bin:${PATH}"
  if ! command -v bun &>/dev/null; then
    error "Bun installation failed. Install it manually from https://bun.sh and try again."
  fi
  installed_bun_version="$(bun --version)"
  info "Bun ${installed_bun_version} installed successfully"
  if [ "${installed_bun_version}" != "${EXPECTED_BUN_VERSION}" ]; then
    echo "warning: installed bun ${installed_bun_version} does not match expected ${EXPECTED_BUN_VERSION} (keep setup.sh and .tool-versions in sync when upgrading)" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Configure git to use .githooks/ for pre-commit hooks (works in worktrees)
# ---------------------------------------------------------------------------
info "Configuring git hooks"
git config core.hooksPath .githooks

# ---------------------------------------------------------------------------
# Install dependencies and register local packages as linkable
# ---------------------------------------------------------------------------
for dir in cli gateway assistant credential-executor; do
  info "Installing dependencies in ${dir}/"
  (cd "${REPO_ROOT}/${dir}" && bun install)
  info "Registering ${dir}/ as a linkable package"
  (cd "${REPO_ROOT}/${dir}" && bun link)
done

# ---------------------------------------------------------------------------
# Install dependencies for scripts/
# ---------------------------------------------------------------------------
info "Installing dependencies in scripts/"
(cd "${REPO_ROOT}/scripts" && bun install)

# ---------------------------------------------------------------------------
# Install dependencies for packages in packages/
# ---------------------------------------------------------------------------
for dir in "${REPO_ROOT}"/packages/*/; do
  [ -f "${dir}/package.json" ] || continue
  pkg="$(basename "${dir}")"
  info "Installing dependencies in packages/${pkg}/"
  (cd "${dir}" && bun install)
done

# ---------------------------------------------------------------------------
# Install dependencies for skills that have their own package.json
#
# assistant/src/daemon/external-skills-bootstrap.ts statically imports
# skills/meet-join/register.ts, so `tsc --noEmit` in assistant/ follows the
# import into the skill and needs the skill's own node_modules to resolve
# transitive imports. Missing deps surface as false-positive "Cannot find
# module" errors.
# ---------------------------------------------------------------------------
for dir in "${REPO_ROOT}"/skills/*/; do
  [ -f "${dir}/package.json" ] || continue
  pkg="$(basename "${dir}")"
  info "Installing dependencies in skills/${pkg}/"
  (cd "${dir}" && bun install)
done

# ---------------------------------------------------------------------------
# Link local packages into meta so it resolves to local source
# ---------------------------------------------------------------------------
info "Linking local packages into meta/"
(cd "${REPO_ROOT}/meta" && bun link @vellumai/cli @vellumai/assistant @vellumai/vellum-gateway @vellumai/credential-executor)

# ---------------------------------------------------------------------------
# Link the global `vellum` command to this repo's meta package
# ---------------------------------------------------------------------------
info "Linking global 'vellum' command to meta/"
(cd "${REPO_ROOT}/meta" && bun link)

# ---------------------------------------------------------------------------
# Install shell completions for the `vellum` command
# ---------------------------------------------------------------------------
info "Installing shell completions for vellum"

VELLUM_COMP_DIR="${HOME}/.config/vellum/completions"
mkdir -p "${VELLUM_COMP_DIR}"

LOCKFILE_PATH="${HOME}/.vellum.lock.json"
LOCKFILE_GREP="grep -o '\"assistantId\"[[:space:]]*:[[:space:]]*\"[^\"]*\"' ${LOCKFILE_PATH} 2>/dev/null | awk -F'\"' '{print \$(NF-1)}'"

# — Bash completions —
cat > "${VELLUM_COMP_DIR}/completions.bash" << 'BASH_COMP'
_vellum_completions() {
  local cur prev commands
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  commands="client hatch ps retire sleep wake"

  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )
    return 0
  fi

  case "${COMP_WORDS[1]}" in
    hatch)
      COMPREPLY=( $(compgen -W "openclaw vellum -d --name --remote" -- "${cur}") )
      ;;
    client|retire)
      local instances
BASH_COMP

# Append the dynamic lockfile lookup (needs variable expansion)
cat >> "${VELLUM_COMP_DIR}/completions.bash" << BASH_COMP_DYN
      instances="\$(${LOCKFILE_GREP} | tr '\n' ' ')"
BASH_COMP_DYN

cat >> "${VELLUM_COMP_DIR}/completions.bash" << 'BASH_COMP_END'
      COMPREPLY=( $(compgen -W "${instances}" -- "${cur}") )
      ;;
  esac

  return 0
}

complete -F _vellum_completions vellum
BASH_COMP_END

# — Zsh completions —
cat > "${VELLUM_COMP_DIR}/completions.zsh" << 'ZSH_COMP'
_vellum() {
  local -a commands
  commands=(
    'client'
    'hatch'
    'ps'
    'retire'
    'sleep'
    'wake'
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
        hatch)
          _arguments '*:species:(openclaw vellum -d --name --remote)'
          ;;
        client|retire)
          local -a instances
ZSH_COMP

# Append the dynamic lockfile lookup (needs variable expansion)
cat >> "${VELLUM_COMP_DIR}/completions.zsh" << ZSH_COMP_DYN
          instances=(\${(f)"\$(${LOCKFILE_GREP})"})
ZSH_COMP_DYN

cat >> "${VELLUM_COMP_DIR}/completions.zsh" << 'ZSH_COMP_END'
          _describe 'instance' instances
          ;;
      esac
      ;;
  esac
}

compdef _vellum vellum
ZSH_COMP_END

# ---------------------------------------------------------------------------
# Wire up PATH + completions in shell rc files.
#
# nix / home-manager manage ~/.zshrc (and friends) as read-only symlinks into
# the nix store. When the canonical rc isn't writable, fall back to a writable
# "*.local" escape hatch it already sources (e.g. ~/.zshrc sources
# ~/.zshenv.local) so our additions still load. If no hatch is found we use a
# "<rc>.local" sidecar and tell the user to source it from their config.
# ---------------------------------------------------------------------------
BUN_BIN="${HOME}/.bun/bin"

# Echo the writable file to append to for a given canonical rc.
rc_target() {
  local rc="$1"
  if [ -w "$rc" ]; then
    printf '%s' "$rc"
    return
  fi
  # Read-only rc (nix symlink): reuse a "source ~/...local" hatch it already
  # sources; otherwise fall back to a "<rc>.local" sidecar.
  local hatch
  hatch="$(sed -n 's/.*source[[:space:]]*\(~[^ ;&]*\.local\).*/\1/p' "$rc" 2>/dev/null | head -1)"
  if [ -n "$hatch" ]; then
    printf '%s' "${hatch/#\~/$HOME}"
  else
    printf '%s' "${rc}.local"
  fi
}

# Warn if our chosen target isn't actually sourced by the canonical rc.
warn_unsourced() {
  local rc="$1" target="$2"
  [ "$rc" = "$target" ] && return
  if ! grep -qF "$(basename "$target")" "$rc" 2>/dev/null; then
    echo "warning: ${rc} is read-only and does not source ${target}." >&2
    echo "         Add this to your shell config so completions load:" >&2
    echo "         [[ -f ${target} ]] && source ${target}" >&2
  fi
}

# — Ensure ~/.bun/bin is on PATH in shell rc files —
for rc in "${HOME}/.bashrc" "${HOME}/.zshrc"; do
  [ -e "$rc" ] || continue
  target="$(rc_target "$rc")"
  warn_unsourced "$rc" "$target"
  [ -e "$target" ] || touch "$target"
  if ! grep -qF "${BUN_BIN}" "$target"; then
    printf '\nexport PATH="%s:$PATH"\n' "${BUN_BIN}" >> "$target"
  fi
done

# — Source completions from shell rc files —
if [ -e "${HOME}/.bashrc" ]; then
  target="$(rc_target "${HOME}/.bashrc")"
  [ -e "$target" ] || touch "$target"
  if ! grep -qF '.config/vellum/completions/completions.bash' "$target"; then
    printf '\n# vellum completions\nsource ~/.config/vellum/completions/completions.bash\n' >> "$target"
  fi
fi

if [ -e "${HOME}/.zshrc" ]; then
  target="$(rc_target "${HOME}/.zshrc")"
  [ -e "$target" ] || touch "$target"
  if ! grep -qF '.config/vellum/completions/completions.zsh' "$target"; then
    # The escape hatch may be sourced before compinit defines `compdef`, so
    # ensure the completion system is initialized before sourcing.
    {
      printf '\n# vellum completions\n'
      printf 'if ! whence compdef >/dev/null 2>&1; then autoload -Uz compinit && compinit; fi\n'
      printf 'source ~/.config/vellum/completions/completions.zsh\n'
    } >> "$target"
  fi
fi

info "Setup complete! Run 'vellum --version' to verify."
