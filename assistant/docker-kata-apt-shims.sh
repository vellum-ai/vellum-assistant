#!/usr/bin/env sh
# Regenerates host-side shims for chroot-installed commands whose /usr/bin
# entry is a tiny wrapper script exec'ing a hardcoded absolute path (Debian
# 7zip's /usr/bin/7z execs /usr/lib/7zip/7z, for example). Those targets only
# exist inside the chroot, so running the wrapper through the host PATH
# overlay fails; each shim execs the chroot-prefixed target instead.
# docker-kata-apt-env.sh and buildSanitizedEnv put the shim dir on PATH ahead
# of the chroot bin dirs so shims shadow the broken wrappers.
set -eu

DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"
SHIM_DIR="${DATA_ROOT}/.host-shims"
MARKER="# vellum-apt-shim:"

[ -d "${DATA_ROOT}/usr/bin" ] || exit 0
mkdir -p "${SHIM_DIR}"

# Scanning /usr/bin forks a few processes per file; skip it when the dpkg
# database is unchanged (read-only invocations like `apt list` or `dpkg -l`).
STAMP_FILE="${SHIM_DIR}/.dpkg-status-stamp"
STAMP="$(stat -c '%Y %s' "${DATA_ROOT}/var/lib/dpkg/status" 2>/dev/null || true)"
if [ -n "${STAMP}" ] && [ "${STAMP}" = "$(cat "${STAMP_FILE}" 2>/dev/null || true)" ]; then
  exit 0
fi

# Extracts the target of a one-line `exec /abs/path "$@"` trampoline.
wrapper_target() {
  sed -n 's/^[[:space:]]*exec[[:space:]][[:space:]]*\(\/[^"[:space:]][^"[:space:]]*\)[[:space:]][[:space:]]*"\$@".*/\1/p' "$1" | sed -n '1p'
}

# Drop stale shims whose wrapper or chroot target has gone away.
for shim in "${SHIM_DIR}"/*; do
  [ -f "${shim}" ] || continue
  grep -qs "^${MARKER}" "${shim}" || continue
  name="$(basename "${shim}")"
  target="$(sed -n "s|^${MARKER} ||p" "${shim}" | sed -n '1p')"
  if [ -z "${target}" ] || [ ! -x "${DATA_ROOT}/usr/bin/${name}" ] || [ ! -x "${DATA_ROOT}${target}" ]; then
    rm -f "${shim}"
  fi
done

for bin in "${DATA_ROOT}/usr/bin/"*; do
  [ -f "${bin}" ] && [ -x "${bin}" ] || continue
  # Wrapper trampolines are tiny scripts; skip anything else cheaply.
  [ "$(wc -c <"${bin}")" -le 512 ] || continue
  case "$(head -c 2 "${bin}" 2>/dev/null)" in
    '#!') ;;
    *) continue ;;
  esac
  target="$(wrapper_target "${bin}")"
  [ -n "${target}" ] || continue
  # Only shim when the hardcoded path is broken on the host but real in the
  # chroot.
  if [ -e "${target}" ] || [ ! -x "${DATA_ROOT}${target}" ]; then
    continue
  fi
  shim="${SHIM_DIR}/$(basename "${bin}")"
  printf '%s\n' \
    '#!/bin/sh' \
    "${MARKER} ${target}" \
    "exec \"${DATA_ROOT}${target}\" \"\$@\"" \
    >"${shim}"
  chmod +x "${shim}"
done

if [ -n "${STAMP}" ]; then
  printf '%s\n' "${STAMP}" >"${STAMP_FILE}"
fi
