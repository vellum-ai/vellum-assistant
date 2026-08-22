#!/usr/bin/env sh
# apt/apt-get/dpkg wrapper (symlinked from /usr/local/bin). On Kata-family
# runtimes, package operations are routed into the persistent apt chroot so
# they survive machine saves; the image rootfs is discarded on every save.
# The chroot runs through docker-kata-chroot-exec.sh in a private mount
# namespace with /dev, /dev/pts and /proc available, so apt can allocate a
# pty for term.log and maintainer scripts see a normal system.
set -eu

TOOL_NAME="$(basename "$0")"
case "${TOOL_NAME}" in
  apt | apt-get | dpkg) ;;
  *) TOOL_NAME="apt-get" ;;
esac

. /app/assistant/docker-kata-runtime-family.sh

if ! vellum_is_kata_family_runtime; then
  exec "/usr/bin/${TOOL_NAME}" "$@"
fi

if [ "${TOOL_NAME}" != "dpkg" ]; then
  export DEBIAN_FRONTEND=noninteractive
fi
DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"

/app/assistant/docker-init-apt-root.sh
if [ -x "${DATA_ROOT}/bin/sh" ] && [ -x "${DATA_ROOT}/usr/bin/${TOOL_NAME}" ] && [ -f "${DATA_ROOT}/.rootfs-initialized" ] && ! grep -qs " ${DATA_ROOT} .*noexec" /proc/mounts; then
  rc=0
  # Platform kata pods are privileged inside their per-assistant VM, so
  # unshare -m works there; if this environment can't create a mount
  # namespace, fall back to a bare chroot: installs still persist, but with
  # no /dev/pts or /proc apt logs a pty warning and the caller's cwd is not
  # restored.
  if unshare -m true 2>/dev/null; then
    unshare -m /app/assistant/docker-kata-chroot-exec.sh "${DATA_ROOT}" "${PWD}" "/usr/bin/${TOOL_NAME}" "$@" || rc=$?
  else
    chroot "${DATA_ROOT}" "/usr/bin/${TOOL_NAME}" "$@" || rc=$?
  fi
  # Packages can install wrapper scripts that hardcode absolute paths which
  # only resolve inside the chroot; refresh host-side shims for those.
  /app/assistant/docker-kata-apt-shims.sh || true
  exit "${rc}"
fi
exec "/usr/bin/${TOOL_NAME}" "$@"
