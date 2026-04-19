#!/usr/bin/env bash
# setup-auto-tmux.sh — Add/remove auto-tmux wrapping for new interactive shells.
#
# Usage:
#   bash setup-auto-tmux.sh             # Install the hook
#   bash setup-auto-tmux.sh --uninstall # Remove the hook
#
# What it does:
#   Adds a block to .zshrc (or .bashrc) that auto-starts a named tmux session
#   for every new interactive shell. The session name is based on the TTY and
#   PID, so each terminal tab/window gets its own session.
#
#   Sessions created this way are fully visible to the assistant via tmux
#   list-sessions / capture-pane / send-keys.
#
# Supported shells: zsh, bash
# Supported terminals: iTerm2, Terminal.app, VSCode, Alacritty, any terminal

set -euo pipefail

MARKER_START="# >>> vellum-auto-tmux >>>"
MARKER_END="# <<< vellum-auto-tmux <<<"

AUTO_TMUX_BLOCK='# >>> vellum-auto-tmux >>>
# Auto-wrap new interactive shells in tmux so the assistant can see/drive them.
# Managed by: terminal-sessions skill. Remove this block or run setup-auto-tmux.sh --uninstall to disable.
if command -v tmux &>/dev/null && [ -z "${TMUX:-}" ] && [ -n "${PS1:-}" ] && [ -z "${VELLUM_NO_AUTO_TMUX:-}" ]; then
  # Build a human-friendly session name from the terminal tab/window
  _vellum_tty_slug="$(basename "$(tty)" 2>/dev/null | tr "/" "-")"
  _vellum_session="sh-${_vellum_tty_slug}-$$"

  # If we are inside iTerm2, try to use the tab title as the session name
  if [ -n "${ITERM_SESSION_ID:-}" ]; then
    _vellum_session="iterm-${_vellum_tty_slug}-$$"
  fi

  # If we are inside VSCode integrated terminal, tag it
  if [ "${TERM_PROGRAM:-}" = "vscode" ]; then
    _vellum_session="vscode-${_vellum_tty_slug}-$$"
  fi

  tmux new-session -d -s "$_vellum_session" 2>/dev/null && exec tmux attach-session -t "$_vellum_session"
  unset _vellum_tty_slug _vellum_session
fi
# <<< vellum-auto-tmux <<<'

# Detect shell config file
detect_rc_file() {
  local shell_name
  shell_name="$(basename "$SHELL")"
  case "$shell_name" in
    zsh)  echo "$HOME/.zshrc" ;;
    bash)
      # macOS uses .bash_profile for login shells, but .bashrc for interactive
      if [ -f "$HOME/.bashrc" ]; then
        echo "$HOME/.bashrc"
      else
        echo "$HOME/.bash_profile"
      fi
      ;;
    *)
      echo "$HOME/.${shell_name}rc"
      ;;
  esac
}

install() {
  local rc_file
  rc_file="$(detect_rc_file)"

  # Check if already installed
  if grep -qF "$MARKER_START" "$rc_file" 2>/dev/null; then
    echo "✓ Auto-tmux is already installed in $rc_file"
    echo "  Run with --uninstall to remove it."
    exit 0
  fi

  # Back up the rc file
  cp "$rc_file" "${rc_file}.vellum-backup.$(date +%s)" 2>/dev/null || true

  # Append the block
  {
    echo ""
    echo "$AUTO_TMUX_BLOCK"
  } >> "$rc_file"

  echo "✓ Auto-tmux installed in $rc_file"
  echo "  New terminal windows will auto-create tmux sessions."
  echo "  Set VELLUM_NO_AUTO_TMUX=1 to skip for a single session."
  echo "  Run with --uninstall to remove."
}

uninstall() {
  local rc_file
  rc_file="$(detect_rc_file)"

  if ! grep -qF "$MARKER_START" "$rc_file" 2>/dev/null; then
    echo "✓ Auto-tmux is not installed in $rc_file — nothing to remove."
    exit 0
  fi

  # Back up first
  cp "$rc_file" "${rc_file}.vellum-backup.$(date +%s)"

  # Remove the block between markers (inclusive)
  # Use a temp file for portability (macOS sed -i is different from GNU)
  local tmp_file
  tmp_file="$(mktemp)"
  awk "
    /$MARKER_START/{skip=1; next}
    /$MARKER_END/{skip=0; next}
    !skip
  " "$rc_file" > "$tmp_file"
  mv "$tmp_file" "$rc_file"

  echo "✓ Auto-tmux removed from $rc_file"
}

# --- Main ---

case "${1:-}" in
  --uninstall)
    uninstall
    ;;
  --help|-h)
    echo "Usage: bash setup-auto-tmux.sh [--uninstall]"
    echo ""
    echo "Install or remove the auto-tmux hook for new terminal sessions."
    echo "This lets the assistant see and interact with all your terminal windows."
    ;;
  *)
    install
    ;;
esac
