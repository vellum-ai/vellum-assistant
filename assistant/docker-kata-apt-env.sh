#!/usr/bin/env sh

. /app/assistant/docker-kata-runtime-family.sh

if ! vellum_is_kata_family_runtime; then
  return 0 2>/dev/null || exit 0
fi

export VELLUM_APT_DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"

_vellum_kata_append_path() {
  case ":${PATH:-}:" in
    *":$1:"*) ;;
    *) PATH="${PATH:+${PATH}:}$1" ;;
  esac
}

_vellum_kata_prepend_library_path() {
  case ":${LD_LIBRARY_PATH:-}:" in
    *":$1:"*) ;;
    *) LD_LIBRARY_PATH="$1${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}" ;;
  esac
}

_vellum_kata_append_path "${VELLUM_APT_DATA_ROOT}/bin"
_vellum_kata_append_path "${VELLUM_APT_DATA_ROOT}/usr/local/sbin"
_vellum_kata_append_path "${VELLUM_APT_DATA_ROOT}/usr/local/bin"
_vellum_kata_append_path "${VELLUM_APT_DATA_ROOT}/usr/sbin"
_vellum_kata_append_path "${VELLUM_APT_DATA_ROOT}/usr/bin"
_vellum_kata_append_path "${VELLUM_APT_DATA_ROOT}/sbin"
_vellum_kata_append_path "${VELLUM_APT_DATA_ROOT}/usr/games"
_vellum_kata_append_path "${VELLUM_APT_DATA_ROOT}/games"
export PATH

_vellum_kata_prepend_library_path "${VELLUM_APT_DATA_ROOT}/usr/lib/aarch64-linux-gnu"
_vellum_kata_prepend_library_path "${VELLUM_APT_DATA_ROOT}/usr/lib/x86_64-linux-gnu"
_vellum_kata_prepend_library_path "${VELLUM_APT_DATA_ROOT}/usr/lib"
_vellum_kata_prepend_library_path "${VELLUM_APT_DATA_ROOT}/usr/local/lib"
export LD_LIBRARY_PATH

unset -f _vellum_kata_append_path _vellum_kata_prepend_library_path
