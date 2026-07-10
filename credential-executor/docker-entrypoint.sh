#!/bin/sh
# CES image launcher, installed at /usr/local/bin/ces-entrypoint.sh.
# vembda's stateful_template.yaml calls that path (optionally through
# vellum-block-volume-mount.sh), so keep it stable across releases.
set -eu

cd /app/credential-executor

# Raise the fd soft limit; non-fatal when the runtime hard limit is lower.
ulimit -n 35000 2>/dev/null || echo "ces-entrypoint: ulimit -n 35000 failed; using $(ulimit -n)" >&2

exec bun run src/main.ts
