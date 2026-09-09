#!/bin/sh
# Installed as /usr/local/bin/node. The image ships no Node, so `bunx <pkg>`
# follows a bin's `#!/usr/bin/env node` shebang here.
#
# A real Node interpreter always wins. One can appear after the image is built:
# `apt-get install nodejs` writes /usr/bin/node, and on Kata-family runtimes the
# persistent apt chroot puts it under $VELLUM_APT_DATA_ROOT/usr/bin, which the
# sandbox PATH carries. Delegating keeps Node CLIs on Node semantics.
#
# With no real Node on PATH the bin runs under Bun with the auto-serve shim
# preloaded, so a CLI whose default export carries a `fetch` method exits
# instead of being turned into an HTTP server by `bun:main`.
#
# Bun's own synthesized shim dirs (<temp>/bun-node-<hash>/node, symlinks to
# bun) are skipped: that `node` is Bun without the preload, which is the hang
# this launcher exists to prevent.

launcher=/usr/local/bin/node
shim=/app/assistant/docker-bun-no-autoserve.js

IFS=:
for dir in $PATH; do
  [ -n "$dir" ] || continue
  candidate="$dir/node"
  case "$candidate" in
    "$launcher" | */bun-node-*/node) continue ;;
  esac
  [ -f "$candidate" ] && [ -x "$candidate" ] || continue
  if [ -L "$candidate" ] && [ "$(readlink -f "$candidate")" = "$launcher" ]; then
    continue
  fi
  unset IFS
  exec "$candidate" "$@"
done
unset IFS

exec /usr/local/bin/bun --preload="$shim" "$@"
