#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "${SCRIPT_DIR}/vellum-block-volume-common.sh"

block_mount_bind_spec() {
  source_name="$1"
  target="$2"
  mode="$3"
  source_path="$(block_child_path "${source_name}")"

  block_ensure_dir "${source_path}"
  block_ensure_dir "${target}"

  if block_find_mountpoint "${target}"; then
    block_log "${target} is already mounted"
  else
    block_run "mount --bind ${source_path} ${target}" mount --bind "${source_path}" "${target}"
  fi

  if [ "${mode}" = "ro" ]; then
    block_run "mount -o remount,bind,ro ${target}" mount -o remount,bind,ro "${target}"
  fi
}

block_join_command() {
  joined=""
  for arg in "$@"; do
    joined="${joined}${joined:+ }${arg}"
  done
  printf '%s\n' "${joined}"
}

block_validate_exec_env() {
  uid="${VELLUM_BLOCK_EXEC_UID:-}"
  gid="${VELLUM_BLOCK_EXEC_GID:-}"

  if [ -n "${uid}" ] && [ -z "${gid}" ]; then
    block_die "VELLUM_BLOCK_EXEC_UID and VELLUM_BLOCK_EXEC_GID must be set together"
  fi
  if [ -z "${uid}" ] && [ -n "${gid}" ]; then
    block_die "VELLUM_BLOCK_EXEC_UID and VELLUM_BLOCK_EXEC_GID must be set together"
  fi

  if [ -n "${uid}" ]; then
    block_validate_number "VELLUM_BLOCK_EXEC_UID" "${uid}"
    block_validate_number "VELLUM_BLOCK_EXEC_GID" "${gid}"
  fi
}

block_exec_service() {
  uid="${VELLUM_BLOCK_EXEC_UID:-}"
  gid="${VELLUM_BLOCK_EXEC_GID:-}"

  command_display="$(block_join_command "$@")"

  if [ -n "${uid}" ]; then
    setpriv_display="setpriv --reuid ${uid} --regid ${gid} --clear-groups -- ${command_display}"

    if block_is_dry_run; then
      block_dry_run "exec ${setpriv_display}"
      return 0
    fi

    exec setpriv --reuid "${uid}" --regid "${gid}" --clear-groups -- "$@"
  fi

  if block_is_dry_run; then
    block_dry_run "exec ${command_display}"
    return 0
  fi
  exec "$@"
}

block_validate_mode_env
block_init_defaults

while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  block_die "unexpected argument '$1'; service command must follow --"
done

[ "$#" -gt 0 ] || block_die "service command is required after --"

block_validate_exec_env
block_wait_for_device
block_mount_root
block_for_each_bind_spec "${VELLUM_BLOCK_BIND_SPECS:-}" block_mount_bind_spec
block_exec_service "$@"
