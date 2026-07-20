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

_vellum_kata_prepend_path() {
  case ":${PATH:-}:" in
    *":$1:"*) ;;
    *) PATH="$1${PATH:+:${PATH}}" ;;
  esac
}

_vellum_kata_append_pythonpath() {
  case ":${PYTHONPATH:-}:" in
    *":$1:"*) ;;
    *) PYTHONPATH="${PYTHONPATH:+${PYTHONPATH}:}$1" ;;
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

# Make python packages installed into the chroot importable by the image
# python: apt packages land in the unversioned dist-packages dir, chroot pip
# installs in the versioned /usr/local one. The chroot suite matches the image
# suite, so the image python's version selects the right pip dir.
_vellum_kata_python_version="$(/usr/bin/python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
_vellum_kata_append_pythonpath "${VELLUM_APT_DATA_ROOT}/usr/lib/python3/dist-packages"
if [ -n "${_vellum_kata_python_version}" ]; then
  _vellum_kata_append_pythonpath "${VELLUM_APT_DATA_ROOT}/usr/local/lib/python${_vellum_kata_python_version}/dist-packages"
fi
unset _vellum_kata_python_version
export PYTHONPATH

# The image bakes these under /home/assistant, which is ephemeral rootfs; on
# kata pods $HOME is the persistent data volume, so user-level installs there
# survive machine saves.
if [ -n "${HOME:-}" ]; then
  export PYTHONUSERBASE="${HOME}/.python"
  export BUN_INSTALL="${HOME}/.bun"
  _vellum_kata_prepend_path "${BUN_INSTALL}/bin"
  _vellum_kata_prepend_path "${PYTHONUSERBASE}/bin"
fi
export PATH

unset -f _vellum_kata_append_path _vellum_kata_prepend_path _vellum_kata_append_pythonpath _vellum_kata_prepend_library_path
