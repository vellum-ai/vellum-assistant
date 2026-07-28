#!/usr/bin/env sh
# Runs pip inside the persistent apt chroot. Must be invoked under `unshare -m`
# (see docker-kata-pip.sh): the bind mounts below live in a private mount
# namespace so they disappear with the pip process and are never visible to
# other processes — a lingering /data bind inside the chroot would create a
# path cycle (/data/system/data/system/...) for anything walking /data.
set -eu

DATA_ROOT="$1"
CALLER_CWD="$2"
PIP_BIN="$3"
shift 3

for dir in /workspace /data /tmp /var/tmp; do
  [ -d "${dir}" ] || continue
  mkdir -p "${DATA_ROOT}${dir}"
  mount --bind "${dir}" "${DATA_ROOT}${dir}" 2>/dev/null || true
done

# chroot(1) always chdirs to /; restore the caller's cwd when it exists inside
# the chroot so relative paths keep working.
exec chroot "${DATA_ROOT}" /bin/sh -c 'cd "$1" 2>/dev/null || cd /; shift; exec "$@"' sh "${CALLER_CWD}" "${PIP_BIN}" "$@"
