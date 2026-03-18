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
# Pre-flight: ensure bun is available
# ---------------------------------------------------------------------------
if ! command -v bun &>/dev/null; then
  error "bun is not installed. Install it from https://bun.sh and try again."
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
      COMPREPLY=( $(compgen -W "openclaw vellum -d --daemon-only --name --remote" -- "${cur}") )
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
          _arguments '*:species:(openclaw vellum -d --daemon-only --name --remote)'
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

info "Setup complete! Run 'vellum --version' to verify."
