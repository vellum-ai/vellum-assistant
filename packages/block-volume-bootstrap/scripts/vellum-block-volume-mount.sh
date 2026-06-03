#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "${SCRIPT_DIR}/vellum-block-volume-common.sh"

block_mount_bind_spec() {
  source_name="$1"
  target="$2"
  requested_mode="$3"
  source_path="$(block_child_path "${source_name}")"

  block_ensure_dir "${source_path}"
  block_ensure_dir "${target}"

  if block_find_mount_details "${target}"; then
    if ! block_sources_match "${source_path}" "${BLOCK_MOUNT_SOURCE}" &&
      ! block_mount_source_matches_device_fsroot "${source_name}" "${BLOCK_MOUNT_SOURCE}" "${BLOCK_MOUNT_FSROOT}"; then
      block_die "${target} is mounted from ${BLOCK_MOUNT_SOURCE}; expected ${source_path}"
    fi
    if [ "${requested_mode}" = "rw" ]; then
      block_verify_mount_mode "${target}" "rw" "${BLOCK_MOUNT_OPTIONS}"
      block_log "${target} is already mounted"
    elif block_mount_options_include_mode "${BLOCK_MOUNT_OPTIONS}" "ro"; then
      block_log "${target} is already mounted"
    elif block_mount_options_include_mode "${BLOCK_MOUNT_OPTIONS}" "rw"; then
      block_log "${target} is mounted rw; remounting ro"
    else
      block_verify_mount_mode "${target}" "ro" "${BLOCK_MOUNT_OPTIONS}"
    fi
  else
    mount --bind "${source_path}" "${target}"
  fi

  if [ "${requested_mode}" = "ro" ]; then
    mount -o remount,bind,ro "${target}"
  fi
}

block_hide_root_before_exec() {
  umount "${BLOCK_ROOT}"
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

  if [ -n "${uid}" ]; then
    exec setpriv --reuid "${uid}" --regid "${gid}" --clear-groups -- "$@"
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
block_for_each_bind_spec "${VELLUM_BLOCK_BIND_SPECS:-}" :
block_wait_for_device
block_mount_root
block_for_each_bind_spec "${VELLUM_BLOCK_BIND_SPECS:-}" block_mount_bind_spec
block_hide_root_before_exec
block_exec_service "$@"
