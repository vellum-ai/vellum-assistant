#!/usr/bin/env sh
set -eu

DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"
SENTINEL="${DATA_ROOT}/.rootfs-initialized"
LOCK_DIR="${DATA_ROOT}/.rootfs-init.lock"
LOCK_PID="${LOCK_DIR}/pid"
HOST_PATH="/usr/sbin:/usr/bin:/sbin:/bin"

if [ "${VELLUM_SANDBOX_RUNTIME:-}" != "kata" ]; then
  exit 0
fi

# Bootstrap the alternate root with the host toolchain so the wrapper
# binaries in /usr/local/bin do not recurse back into this script.
export PATH="${HOST_PATH}"

rootfs_ready() {
  [ -f "${SENTINEL}" ] && [ -x "${DATA_ROOT}/bin/sh" ] && [ -x "${DATA_ROOT}/usr/bin/apt-get" ]
}

acquire_init_lock() {
  if ! mkdir -p "${DATA_ROOT}"; then
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
  trap 'rm -rf "${LOCK_DIR}"' EXIT
  trap 'rm -rf "${LOCK_DIR}"; exit 130' INT
  trap 'rm -rf "${LOCK_DIR}"; exit 143' TERM
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

if grep -qs " ${DATA_ROOT} .*noexec" /proc/mounts; then
  echo "Warning: ${DATA_ROOT} is mounted noexec; skipping persistent apt rootfs bootstrap" >&2
  exit 0
fi

if ! check_sane_mount "${DATA_ROOT}"; then
  echo "Warning: ${DATA_ROOT} cannot host a chrootable apt rootfs here; falling back to image-root apt installs" >&2
  exit 0
fi

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

debootstrap --variant=minbase --arch="${ARCH}" "${SUITE}" "${DATA_ROOT}" "${MIRROR}"

touch "${SENTINEL}"
