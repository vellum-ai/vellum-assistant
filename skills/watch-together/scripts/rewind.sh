#!/bin/sh
# POSIX compatibility wrapper for the portable rewind implementation.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$SCRIPT_DIR/rewind.py" "$@"
