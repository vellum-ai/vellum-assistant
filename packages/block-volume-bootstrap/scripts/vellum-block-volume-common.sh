#!/usr/bin/env sh
set -eu

block_die() {
  echo "vellum block volume: $*" >&2
  exit 1
}

block_log() {
  echo "vellum block volume: $*" >&2
}

block_is_dry_run() {
  [ "${VELLUM_BLOCK_DRY_RUN:-}" = "1" ]
}

block_dry_run() {
  if block_is_dry_run; then
    echo "DRY-RUN: $*" >&2
  fi
}

block_run() {
  display="$1"
  shift
  if block_is_dry_run; then
    block_dry_run "${display}"
    return 0
  fi
  "$@"
}

block_require_value() {
  name="$1"
  value="$2"
  [ -n "${value}" ] || block_die "${name} is required"
}

block_validate_mode_env() {
  if [ "${VELLUM_FILESYSTEM_MODE:-}" != "block" ]; then
    block_die "VELLUM_FILESYSTEM_MODE=block is required"
  fi
}

block_validate_number() {
  name="$1"
  value="$2"
  case "${value}" in
    ''|*[!0-9]*)
      block_die "${name} must be a numeric id"
      ;;
  esac
}

block_normalize_absolute_non_root_path() {
  name="$1"
  path="$2"

  case "${path}" in
    '') block_die "${name} must not be empty or /" ;;
    /*) ;;
    *) block_die "${name} must be an absolute path" ;;
  esac

  while :; do
    case "${path}" in
      */) path="${path%/}" ;;
      *) break ;;
    esac
  done

  [ -n "${path}" ] || block_die "${name} must not be empty or /"
  printf '%s\n' "${path}"
}

block_detect_fs_type() {
  if block_is_dry_run; then
    block_dry_run "blkid -o value -s TYPE ${BLOCK_DEVICE}"
    printf '%s\n' "${VELLUM_BLOCK_DRY_RUN_BLKID_TYPE:-}"
    return 0
  fi
  blkid -o value -s TYPE "${BLOCK_DEVICE}" 2>/dev/null || true
}

block_init_defaults() {
  BLOCK_DEVICE="${VELLUM_BLOCK_DEVICE:-/dev/assistant-data}"
  BLOCK_ROOT="${VELLUM_BLOCK_ROOT:-/mnt/vellum-block-root}"

  case "${BLOCK_DEVICE}" in
    /*) ;;
    *) block_die "VELLUM_BLOCK_DEVICE must be an absolute path" ;;
  esac

  BLOCK_ROOT="$(block_normalize_absolute_non_root_path "VELLUM_BLOCK_ROOT" "${BLOCK_ROOT}")"
}

block_validate_child_name() {
  name="$1"
  case "${name}" in
    ''|'.'|'..'|/*|*/*|*[!A-Za-z0-9._-]*)
      block_die "invalid block root child '${name}'"
      ;;
  esac
}

block_child_path() {
  block_validate_child_name "$1"
  printf '%s/%s\n' "${BLOCK_ROOT}" "$1"
}

block_normalize_target_path() {
  target="$1"
  block_normalize_absolute_non_root_path "bind target" "${target}"
}

block_wait_for_device() {
  timeout="${VELLUM_BLOCK_DEVICE_WAIT_TIMEOUT_SECONDS:-60}"
  block_validate_number "VELLUM_BLOCK_DEVICE_WAIT_TIMEOUT_SECONDS" "${timeout}"

  if block_is_dry_run; then
    block_dry_run "wait for block device ${BLOCK_DEVICE}"
    return 0
  fi

  elapsed=0
  while [ ! -b "${BLOCK_DEVICE}" ]; do
    if [ "${elapsed}" -ge "${timeout}" ]; then
      block_die "timed out waiting for block device ${BLOCK_DEVICE}"
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

block_ensure_dir() {
  path="$1"
  block_run "mkdir -p ${path}" mkdir -p "${path}"
}

block_find_mountpoint() {
  target="$1"
  if block_is_dry_run; then
    block_dry_run "findmnt --mountpoint ${target}"
    return 1
  fi
  findmnt --mountpoint "${target}" >/dev/null 2>&1
}

block_mount_root() {
  block_ensure_dir "${BLOCK_ROOT}"
  if block_find_mountpoint "${BLOCK_ROOT}"; then
    block_log "${BLOCK_ROOT} is already mounted"
    return 0
  fi
  block_run "mount ${BLOCK_DEVICE} ${BLOCK_ROOT}" mount "${BLOCK_DEVICE}" "${BLOCK_ROOT}"
}

block_parse_bind_spec() {
  spec="$1"

  case "${spec}" in
    *:*:*) ;;
    *)
      block_die "invalid VELLUM_BLOCK_BIND_SPECS entry '${spec}'; expected source:target:ro|rw"
      ;;
  esac

  BIND_SOURCE_NAME="${spec%%:*}"
  rest="${spec#*:}"
  BIND_TARGET="${rest%%:*}"
  BIND_MODE="${rest#*:}"

  case "${BIND_MODE}" in
    *:*)
      block_die "invalid VELLUM_BLOCK_BIND_SPECS entry '${spec}'; expected source:target:ro|rw"
      ;;
  esac

  if [ "${BIND_SOURCE_NAME}" = "${spec}" ] || [ "${BIND_TARGET}" = "${rest}" ]; then
    block_die "invalid VELLUM_BLOCK_BIND_SPECS entry '${spec}'; expected source:target:ro|rw"
  fi

  block_validate_child_name "${BIND_SOURCE_NAME}"
  BIND_TARGET="$(block_normalize_target_path "${BIND_TARGET}")"
  case "${BIND_MODE}" in
    ro|rw) ;;
    *) block_die "invalid bind mode '${BIND_MODE}' in '${spec}'; expected ro or rw" ;;
  esac
}

block_for_each_bind_spec() {
  specs="$1"
  callback="$2"
  block_require_value "VELLUM_BLOCK_BIND_SPECS" "${specs}"

  remaining="${specs}"
  while :; do
    case "${remaining}" in
      *';'*)
        spec="${remaining%%;*}"
        remaining="${remaining#*;}"
        ;;
      *)
        spec="${remaining}"
        remaining=""
        ;;
    esac

    [ -n "${spec}" ] || block_die "empty VELLUM_BLOCK_BIND_SPECS entry"
    block_parse_bind_spec "${spec}"
    "${callback}" "${BIND_SOURCE_NAME}" "${BIND_TARGET}" "${BIND_MODE}"

    [ -n "${remaining}" ] || break
  done
}
