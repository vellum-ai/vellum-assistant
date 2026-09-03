#!/usr/bin/env sh
# Runs a command inside the persistent apt chroot. Must be invoked under
# `unshare -m` (see docker-kata-pip.sh and docker-kata-apt-wrapper.sh): the
# bind mounts below live in a private mount namespace so they disappear with
# the process and are never visible to other processes; a lingering /data
# bind inside the chroot would create a path cycle (/data/system/data/system/...)
# for anything walking /data.
set -eu

DATA_ROOT="$1"
CALLER_CWD="$2"
shift 2

for dir in /workspace /data /tmp /var/tmp; do
  [ -d "${dir}" ] || continue
  mkdir -p "${DATA_ROOT}${dir}"
  mount --bind "${dir}" "${DATA_ROOT}${dir}" 2>/dev/null || true
done

# /proc and /dev make the chroot behave like a normal system: apt needs a pty
# (posix_openpt via /dev/ptmx) to write /var/log/apt/term.log, and package
# maintainer scripts routinely read /proc. The recursive /dev bind carries the
# container's /dev/pts along; the devpts mount is a fallback for environments
# where it did not produce one.
mkdir -p "${DATA_ROOT}/proc" "${DATA_ROOT}/dev"
mount --bind /proc "${DATA_ROOT}/proc" 2>/dev/null || true
mount --rbind /dev "${DATA_ROOT}/dev" 2>/dev/null || true
if [ ! -e "${DATA_ROOT}/dev/pts/ptmx" ]; then
  mkdir -p "${DATA_ROOT}/dev/pts" 2>/dev/null || true
  mount -t devpts -o gid=5,mode=620,ptmxmode=666 devpts "${DATA_ROOT}/dev/pts" 2>/dev/null || true
fi

# chroot(1) always chdirs to /; restore the caller's cwd when it exists inside
# the chroot so relative paths keep working.
exec chroot "${DATA_ROOT}" /bin/sh -c 'cd "$1" 2>/dev/null || cd /; shift; exec "$@"' sh "${CALLER_CWD}" "$@"
