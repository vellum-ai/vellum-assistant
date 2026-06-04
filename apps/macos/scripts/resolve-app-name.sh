#!/usr/bin/env bash
set -euo pipefail

# Resolve the Electron app's productName at pack time, mirroring the Swift
# client's build.sh so the Dock / Cmd-Tab label matches across both apps.
# Echoes ONLY the resolved name to stdout (consumed via command substitution
# in the `pack` script's `electron-builder -c.productName=...`); diagnostics
# go to stderr.
#
#   production  → "Vellum"        (or ~/.config/vellum/dock-display-name)
#   <env>       → "Vellum <Env>"  (or ~/.config/vellum-<env>/dock-display-name)
#
# The dock-display-name file is the same per-environment XDG override the
# Swift app reads to rename its bundle after the active assistant (e.g.
# "Jet", "Juno"), so a build picks up a custom name with zero extra config.
# Mirrors clients/macos/build.sh's resolution (env-scoped config dir,
# unsafe-char rejection, env-aware default, 16-char MAXCOMLEN warning).

VELLUM_ENVIRONMENT="${VELLUM_ENVIRONMENT:-dev}"

_XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
case "$VELLUM_ENVIRONMENT" in
    production) _CONFIG_DIR="$_XDG_CONFIG_HOME/vellum" ;;
    *)          _CONFIG_DIR="$_XDG_CONFIG_HOME/vellum-${VELLUM_ENVIRONMENT}" ;;
esac
_DOCK_LABEL_FILE="$_CONFIG_DIR/dock-display-name"

# Environment-aware default: "Vellum" for production, "Vellum <Env>" otherwise.
case "$VELLUM_ENVIRONMENT" in
    production) _DEFAULT_NAME="Vellum" ;;
    *) _ENV_LABEL="$(echo "${VELLUM_ENVIRONMENT:0:1}" | tr '[:lower:]' '[:upper:]')${VELLUM_ENVIRONMENT:1}"
       _DEFAULT_NAME="Vellum ${_ENV_LABEL}" ;;
esac

PRODUCT_NAME="$_DEFAULT_NAME"
if [ -f "$_DOCK_LABEL_FILE" ]; then
    _SAVED_NAME="$(tr -d '\n' < "$_DOCK_LABEL_FILE" 2>/dev/null || true)"
    if [ -n "${_SAVED_NAME:-}" ]; then
        # Reject XML-reserved chars (&, <, >) or path separators (/) that would
        # break the generated Info.plist or the .app path.
        if [[ "$_SAVED_NAME" =~ [/\<\>\&] ]]; then
            echo "resolve-app-name: dock-display-name contains unsafe characters, using '$_DEFAULT_NAME'" >&2
        else
            PRODUCT_NAME="$_SAVED_NAME"
        fi
    fi
fi

# macOS stores process names in p_comm[MAXCOMLEN+1] (MAXCOMLEN=16); longer
# names are silently truncated, which breaks `pgrep -x`. Warn, don't fail —
# matches build.sh.
if [ "${#PRODUCT_NAME}" -gt 16 ]; then
    echo "resolve-app-name: '$PRODUCT_NAME' is ${#PRODUCT_NAME} chars (>16; pgrep -x may truncate)" >&2
fi

echo "resolve-app-name: VELLUM_ENVIRONMENT=$VELLUM_ENVIRONMENT productName=$PRODUCT_NAME" >&2
printf '%s' "$PRODUCT_NAME"
