#!/usr/bin/env sh
set -eu

DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"
ROOT_PARENT="$(dirname "${DATA_ROOT}")"
SENTINEL="${DATA_ROOT}/.rootfs-initialized"
BOOTSTRAP_ROOT="${DATA_ROOT}.bootstrap.$$"
PROBE_ROOT="${DATA_ROOT}.probe.$$"
LOCK_DIR="${DATA_ROOT}.rootfs-init.lock"
LOCK_PID="${LOCK_DIR}/pid"
HOST_PATH="/usr/sbin:/usr/bin:/sbin:/bin"

. /app/assistant/docker-kata-runtime-family.sh

if ! vellum_is_kata_family_runtime; then
  exit 0
fi

case "${DATA_ROOT}" in
  ''|/)
    echo "Warning: invalid VELLUM_APT_DATA_ROOT '${DATA_ROOT}'; falling back to image-root apt installs" >&2
    exit 0
    ;;
esac

# Bootstrap the alternate root with the host toolchain so the wrapper
# binaries in /usr/local/bin do not recurse back into this script.
export PATH="${HOST_PATH}"

rootfs_ready() {
  [ -f "${SENTINEL}" ] && [ -x "${DATA_ROOT}/bin/sh" ] && [ -x "${DATA_ROOT}/usr/bin/apt-get" ]
}

acquire_init_lock() {
  if ! mkdir -p "${ROOT_PARENT}"; then
    return 1
  fi

  while ! mkdir "${LOCK_DIR}" 2>/dev/null; do
    if [ ! -d "${LOCK_DIR}" ]; then
      return 1
    fi

    if rootfs_ready; then
      exit 0
    fi

    if [ ! -r "${LOCK_PID}" ]; then
      sleep 1
      if [ ! -r "${LOCK_PID}" ]; then
        rm -rf "${LOCK_DIR}" 2>/dev/null || return 1
      fi
      continue
    fi

    lock_pid="$(cat "${LOCK_PID}" 2>/dev/null || true)"
    case "${lock_pid}" in
      ''|*[!0-9]*)
        sleep 1
        if [ "$(cat "${LOCK_PID}" 2>/dev/null || true)" = "${lock_pid}" ]; then
          rm -rf "${LOCK_DIR}" 2>/dev/null || return 1
        fi
        ;;
      *)
        if kill -0 "${lock_pid}" 2>/dev/null; then
          sleep 1
        else
          rm -rf "${LOCK_DIR}" 2>/dev/null || return 1
        fi
        ;;
    esac
  done

  printf '%s\n' "$$" >"${LOCK_PID}" 2>/dev/null || true
  trap 'rm -rf "${LOCK_DIR}" "${BOOTSTRAP_ROOT}" "${PROBE_ROOT}"' EXIT
  trap 'rm -rf "${LOCK_DIR}" "${BOOTSTRAP_ROOT}" "${PROBE_ROOT}"; exit 130' INT
  trap 'rm -rf "${LOCK_DIR}" "${BOOTSTRAP_ROOT}" "${PROBE_ROOT}"; exit 143' TERM
}

check_sane_mount() {
  target="$1"
  probe_dev="${target}/.apt-test-dev-null"
  probe_exec="${target}/.apt-test-exec"
  shell_path="/bin/sh"

  mkdir -p "${target}"

  if ! mknod "${probe_dev}" c 1 3 2>/dev/null || ! echo test >"${probe_dev}"; then
    rm -f "${probe_dev}"
    : >"${probe_dev}"
    if ! mount -o bind /dev/null "${probe_dev}" >/dev/null 2>&1; then
      rm -f "${probe_dev}"
      return 1
    fi
    if ! echo test >"${probe_dev}"; then
      umount "${probe_dev}" >/dev/null 2>&1 || true
      rm -f "${probe_dev}"
      return 1
    fi
    umount "${probe_dev}" >/dev/null 2>&1 || true
  fi
  rm -f "${probe_dev}"

  if [ ! -x "${shell_path}" ]; then
    shell_path="$(command -v sh)"
  fi

  cat >"${probe_exec}" <<EOF
#! ${shell_path}
:
EOF
  chmod +x "${probe_exec}"
  if ! "${probe_exec}" >/dev/null 2>&1; then
    rm -f "${probe_exec}"
    return 1
  fi
  rm -f "${probe_exec}"

  return 0
}

if rootfs_ready; then
  exit 0
fi

if ! acquire_init_lock; then
  echo "Warning: ${DATA_ROOT} cannot host the apt rootfs lock; falling back to image-root apt installs" >&2
  exit 0
fi

if rootfs_ready; then
  exit 0
fi

if grep -qs " ${DATA_ROOT} .*noexec" /proc/mounts || grep -qs " ${ROOT_PARENT} .*noexec" /proc/mounts; then
  echo "Warning: ${DATA_ROOT} is mounted noexec; skipping persistent apt rootfs bootstrap" >&2
  exit 0
fi

if ! check_sane_mount "${PROBE_ROOT}"; then
  echo "Warning: ${DATA_ROOT} cannot host a chrootable apt rootfs here; falling back to image-root apt installs" >&2
  exit 0
fi
rm -rf "${PROBE_ROOT}"

if [ -x "${DATA_ROOT}/bin/sh" ] && [ -x "${DATA_ROOT}/usr/bin/apt-get" ]; then
  touch "${SENTINEL}"
  exit 0
fi

SUITE="${VELLUM_APT_DATA_SUITE:-}"
if [ -z "${SUITE}" ] && [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  SUITE="${VERSION_CODENAME:-trixie}"
fi
if [ -z "${SUITE}" ]; then
  SUITE="trixie"
fi

MIRROR="${VELLUM_APT_DATA_MIRROR:-http://deb.debian.org/debian}"
ARCH="$(/usr/bin/dpkg --print-architecture)"

rm -rf "${BOOTSTRAP_ROOT}"
debootstrap --variant=minbase --arch="${ARCH}" "${SUITE}" "${BOOTSTRAP_ROOT}" "${MIRROR}"

rm -rf "${DATA_ROOT}"
mv "${BOOTSTRAP_ROOT}" "${DATA_ROOT}"
touch "${SENTINEL}"
