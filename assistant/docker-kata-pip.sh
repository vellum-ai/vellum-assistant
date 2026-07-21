#!/usr/bin/env sh
# pip/pip3 wrapper (symlinked from /usr/local/bin). On Kata-family runtimes,
# root pip installs are routed into the persistent apt chroot — like the
# apt/apt-get/dpkg wrappers — so they survive machine saves; the image rootfs
# is discarded on every save. Non-root invocations fall through to the image
# pip, where PIP_BREAK_SYSTEM_PACKAGES makes pip default to a user install
# under the persistent PYTHONUSERBASE.
set -eu

PIP_NAME="$(basename "$0")"
case "${PIP_NAME}" in
  pip | pip3) ;;
  *) PIP_NAME="pip3" ;;
esac

. /app/assistant/docker-kata-runtime-family.sh

if ! vellum_is_kata_family_runtime; then
  exec "/usr/bin/${PIP_NAME}" "$@"
fi

export PIP_BREAK_SYSTEM_PACKAGES=1
DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"

if [ "$(id -u)" = "0" ]; then
  /app/assistant/docker-init-apt-root.sh
  if [ -x "${DATA_ROOT}/bin/sh" ] && [ -f "${DATA_ROOT}/.rootfs-initialized" ] && ! grep -qs " ${DATA_ROOT} .*noexec" /proc/mounts; then
    if [ ! -x "${DATA_ROOT}/usr/bin/${PIP_NAME}" ]; then
      echo "Installing pip into the persistent system root (one-time setup)..." >&2
      chroot "${DATA_ROOT}" sh -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-pip" >&2 || true
    fi
    if [ -x "${DATA_ROOT}/usr/bin/${PIP_NAME}" ]; then
      # The helper bind-mounts caller-visible source dirs into the chroot
      # (inside a private mount namespace) and restores the caller's cwd, so
      # path-based installs (pip install ., -r requirements.txt) and --user
      # installs into $PYTHONUSERBASE resolve to the same files as outside.
      # Platform kata pods are privileged inside their per-assistant VM, so
      # unshare -m works there; if this environment can't create a mount
      # namespace, fall back to a bare chroot — index installs still persist,
      # only caller-path installs lose visibility.
      if unshare -m true 2>/dev/null; then
        exec unshare -m /app/assistant/docker-kata-pip-chroot.sh "${DATA_ROOT}" "${PWD}" "/usr/bin/${PIP_NAME}" "$@"
      fi
      exec chroot "${DATA_ROOT}" /bin/sh -c 'cd "$1" 2>/dev/null || cd /; shift; exec "$@"' sh "${PWD}" "/usr/bin/${PIP_NAME}" "$@"
    fi
  fi
  echo "Warning: persistent pip root unavailable; falling back to the image pip (installs will not survive a save)" >&2
fi

exec "/usr/bin/${PIP_NAME}" "$@"
