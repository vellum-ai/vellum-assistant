#!/usr/bin/env sh
set -eu

if [ "${VELLUM_SANDBOX_RUNTIME:-}" = "kata" ]; then
  exit 0
fi

# Platform Kata assistants currently render the inner-Docker mount, but do not
# expose sandbox_runtime as an env var inside assistant-container.
if [ "${IS_PLATFORM:-}" = "1" ] && grep -qs " /var/lib/docker " /proc/mounts; then
  exit 0
fi

exit 1
