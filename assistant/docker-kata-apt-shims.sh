#!/usr/bin/env sh
# Regenerates host-side shims for chroot-installed commands whose bin entry
# is a pure trampoline script exec'ing a hardcoded absolute path (Debian
# 7zip's /usr/bin/7z execs /usr/lib/7zip/7z, for example). Those targets only
# exist inside the chroot, so running the wrapper through the host PATH
# overlay fails; each shim execs the chroot-prefixed target instead.
# docker-kata-apt-env.sh and buildSanitizedEnv put the shim dir on PATH ahead
# of the chroot bin dirs so shims shadow the broken wrappers.
set -eu

DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"
SHIM_DIR="${DATA_ROOT}/.host-shims"
MARKER="# vellum-apt-shim:"
# dpkg-managed dirs on the PATH overlay (Debian policy keeps packages out of
# /usr/local; /bin and /sbin are usrmerge symlinks into these). Listed
# lowest-priority first so a name present in two dirs gets its shim from the
# higher-priority one.
SCAN_DIRS="usr/games usr/sbin usr/bin"

[ -d "${DATA_ROOT}/usr/bin" ] || exit 0
mkdir -p "${SHIM_DIR}"

# Scanning the bin dirs forks a few processes per file; skip it when the dpkg
# database is unchanged (read-only invocations like `apt list` or `dpkg -l`).
STAMP_FILE="${SHIM_DIR}/.dpkg-status-stamp"
STAMP="$(stat -c '%Y %s' "${DATA_ROOT}/var/lib/dpkg/status" 2>/dev/null || true)"
if [ -n "${STAMP}" ] && [ "${STAMP}" = "$(cat "${STAMP_FILE}" 2>/dev/null || true)" ]; then
  exit 0
fi

# Prints the target of a pure trampoline: a tiny script whose body is nothing
# but the shebang, comments, blank lines, and a single `exec /abs/path "$@"`
# line. Wrappers that do anything else (export env vars, cd, pass extra
# flags) print nothing: a direct-exec shim would bypass that setup.
wrapper_target() {
  [ -f "$1" ] && [ -x "$1" ] || return 0
  [ "$(wc -c <"$1")" -le 512 ] || return 0
  case "$(head -c 2 "$1" 2>/dev/null)" in
    '#!') ;;
    *) return 0 ;;
  esac
  body="$(sed -e '1d' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$1")"
  [ -n "${body}" ] || return 0
  [ "$(printf '%s' "${body}" | wc -l)" -eq 0 ] || return 0
  printf '%s\n' "${body}" | sed -n 's/^[[:space:]]*exec[[:space:]][[:space:]]*\(\/[^"[:space:]][^"[:space:]]*\)[[:space:]][[:space:]]*"\$@"[[:space:]]*$/\1/p'
}

# Highest-priority scanned dir that holds an entry for this shim name.
shim_source() {
  for d in usr/bin usr/sbin usr/games; do
    if [ -e "${DATA_ROOT}/${d}/$1" ]; then
      printf '%s\n' "${DATA_ROOT}/${d}/$1"
      return 0
    fi
  done
}

# Drop stale shims: source gone, source no longer a pure trampoline for the
# recorded target (e.g. an upgrade replaced the wrapper with a real binary
# while leaving the old target installed), or target gone.
for shim in "${SHIM_DIR}"/*; do
  [ -f "${shim}" ] || continue
  grep -qs "^${MARKER}" "${shim}" || continue
  target="$(sed -n "s|^${MARKER} ||p" "${shim}" | sed -n '1p')"
  src="$(shim_source "$(basename "${shim}")")"
  if [ -z "${target}" ] || [ -z "${src}" ] || [ ! -x "${DATA_ROOT}${target}" ] || [ "$(wrapper_target "${src}")" != "${target}" ]; then
    rm -f "${shim}"
  fi
done

for d in ${SCAN_DIRS}; do
  for bin in "${DATA_ROOT}/${d}/"*; do
    target="$(wrapper_target "${bin}")"
    [ -n "${target}" ] || continue
    # Only shim when the hardcoded path is broken on the host but real in
    # the chroot.
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
done

if [ -n "${STAMP}" ]; then
  printf '%s\n' "${STAMP}" >"${STAMP_FILE}"
fi
