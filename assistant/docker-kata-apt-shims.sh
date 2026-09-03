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
# dpkg-managed dirs that can hold trampolines (Debian policy keeps packages
# out of /usr/local; /bin and /sbin are usrmerge symlinks into these).
SCAN_DIRS="usr/bin usr/sbin usr/games"
# Every overlay bin dir in PATH priority order (usrmerge collapses bin/sbin
# into their usr counterparts): precedence must also see the /usr/local dirs
# that chroot pip installs populate, so a dpkg trampoline never shims over a
# higher-priority local command.
PRIORITY_DIRS="usr/bin usr/local/sbin usr/local/bin usr/sbin usr/games"

[ -d "${DATA_ROOT}/usr/bin" ] || exit 0
mkdir -p "${SHIM_DIR}"

# Scanning the bin dirs forks a few processes per file; skip it when the
# overlay state is unchanged (read-only invocations like `apt list` or
# `dpkg -l`). The stamp covers command names, links, effective modes, and small
# executable contents so reinstalls and pip changes invalidate stale shims.
STAMP_FILE="${SHIM_DIR}/.overlay-stamp"
STAMP="$(
  {
    md5sum "${DATA_ROOT}/var/lib/dpkg/status" 2>/dev/null
    for d in ${PRIORITY_DIRS}; do
      printf '%s\0' "${d}"
      find "${DATA_ROOT}/${d}" -mindepth 1 -maxdepth 1 -printf '%P %y %m %l\0' 2>/dev/null | sort -z
      find -L "${DATA_ROOT}/${d}" -mindepth 1 -maxdepth 1 -printf '%P %y %m\0' 2>/dev/null | sort -z
    done
    for d in ${SCAN_DIRS}; do
      find -L "${DATA_ROOT}/${d}" -mindepth 1 -maxdepth 1 -type f -size -513c -perm /111 -print0 2>/dev/null |
        sort -z |
        xargs -0 -r md5sum -z
    done
  } | md5sum | cut -d' ' -f1
)"
if [ "${STAMP}" = "$(cat "${STAMP_FILE}" 2>/dev/null || true)" ]; then
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

# Highest-priority overlay dir that holds an entry for this shim name.
shim_source() {
  for d in ${PRIORITY_DIRS}; do
    candidate="${DATA_ROOT}/${d}/$1"
    if [ -f "${candidate}" ] && [ -x "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
}

generation_failed=0
for d in ${SCAN_DIRS}; do
  for bin in "${DATA_ROOT}/${d}/"*; do
    # Shims outrank every chroot bin dir on PATH, so only the
    # highest-priority entry for a name may produce one: a trampoline in a
    # lower dir must not shadow a real command above it.
    [ "$(shim_source "${bin##*/}")" = "${bin}" ] || continue
    target="$(wrapper_target "${bin}")"
    [ -n "${target}" ] || continue
    # Only shim when the hardcoded path is broken on the host but real in
    # the chroot.
    if [ -e "${target}" ] || [ ! -x "${DATA_ROOT}${target}" ]; then
      continue
    fi
    shim="${SHIM_DIR}/${bin##*/}"
    if ! tmp="$(mktemp "${SHIM_DIR}/.shim.XXXXXX")"; then
      generation_failed=1
      continue
    fi
    if printf '%s\n' \
      '#!/bin/sh' \
      "${MARKER} ${target}" \
      "exec \"${DATA_ROOT}${target}\" \"\$@\"" \
      >"${tmp}" &&
      chmod 0755 "${tmp}" &&
      mv -f "${tmp}" "${shim}"; then
      :
    else
      rm -f "${tmp}"
      generation_failed=1
    fi
  done
done

if [ "${generation_failed}" -ne 0 ]; then
  exit 1
fi

# Drop shims that remain stale after desired replacements are installed.
for shim in "${SHIM_DIR}"/*; do
  [ -f "${shim}" ] || continue
  grep -qs "^${MARKER}" "${shim}" || continue
  target="$(sed -n "s|^${MARKER} ||p" "${shim}" | sed -n '1p')"
  src="$(shim_source "$(basename "${shim}")")"
  if [ -z "${target}" ] || [ -z "${src}" ] || [ ! -x "${DATA_ROOT}${target}" ] || [ "$(wrapper_target "${src}")" != "${target}" ]; then
    rm -f "${shim}"
  fi
done

printf '%s\n' "${STAMP}" >"${STAMP_FILE}"
