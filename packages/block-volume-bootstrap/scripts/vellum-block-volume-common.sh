#!/usr/bin/env sh
set -eu

block_die() {
  echo "vellum block volume: $*" >&2
  exit 1
}

block_log() {
  echo "vellum block volume: $*" >&2
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
  case "${path}" in
    */./*|*/../*|*/.|*/..)
      block_die "${name} must not contain . or .. path components"
      ;;
  esac
  printf '%s\n' "${path}"
}

block_detect_fs_type() {
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

  elapsed=0
  while [ ! -b "${BLOCK_DEVICE}" ]; do
    if [ "${elapsed}" -ge "${timeout}" ]; then
      block_die "timed out waiting for block device ${BLOCK_DEVICE}"
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

block_device_has_mounts() {
  device_real=""

  if findmnt --source "${BLOCK_DEVICE}" >/dev/null 2>&1; then
    return 0
  fi

  if command -v readlink >/dev/null 2>&1; then
    device_real="$(readlink -f "${BLOCK_DEVICE}" 2>/dev/null || true)"
    if [ -n "${device_real}" ] && findmnt --source "${device_real}" >/dev/null 2>&1; then
      return 0
    fi
  fi

  mounted_sources="$(findmnt -rn -o SOURCE 2>/dev/null || true)"
  while IFS= read -r mounted_source; do
    case "${mounted_source}" in
      "${BLOCK_DEVICE}"|"${BLOCK_DEVICE}"\[*)
        return 0
        ;;
    esac
    if [ -n "${device_real}" ]; then
      case "${mounted_source}" in
        "${device_real}"|"${device_real}"\[*)
          return 0
          ;;
      esac
    fi
  done <<EOF
${mounted_sources}
EOF

  return 1
}

block_ensure_dir() {
  mkdir -p "$1"
}

block_find_mount_details() {
  target="$1"
  BLOCK_MOUNT_SOURCE=""
  BLOCK_MOUNT_OPTIONS=""
  BLOCK_MOUNT_FSROOT=""

  if ! findmnt --mountpoint "${target}" >/dev/null 2>&1; then
    return 1
  fi

  BLOCK_MOUNT_SOURCE="$(findmnt -rn -o SOURCE --mountpoint "${target}" 2>/dev/null || true)"
  BLOCK_MOUNT_OPTIONS="$(findmnt -rn -o OPTIONS --mountpoint "${target}" 2>/dev/null || true)"
  BLOCK_MOUNT_FSROOT="$(findmnt -rn -o FSROOT --mountpoint "${target}" 2>/dev/null || true)"
  [ -n "${BLOCK_MOUNT_SOURCE}" ] || block_die "unable to determine mount source for ${target}"
  [ -n "${BLOCK_MOUNT_OPTIONS}" ] || block_die "unable to determine mount options for ${target}"
  return 0
}

block_sources_match() {
  expected="$1"
  actual="$2"
  [ "${expected}" = "${actual}" ] && return 0
  [ "${expected}[/]" = "${actual}" ] && return 0

  if command -v readlink >/dev/null 2>&1; then
    expected_real="$(readlink -f "${expected}" 2>/dev/null || true)"
    actual_real="$(readlink -f "${actual}" 2>/dev/null || true)"
    if [ -n "${expected_real}" ] && [ -n "${actual_real}" ] &&
      [ "${expected_real}" = "${actual_real}" ]; then
      return 0
    fi
    if [ -n "${expected_real}" ] && [ "${expected_real}[/]" = "${actual}" ]; then
      return 0
    fi
  fi

  return 1
}

block_mount_source_matches_device_fsroot() {
  source_name="$1"
  actual_source="$2"
  actual_fsroot="$3"
  expected_fsroot="/${source_name}"

  if block_sources_match "${BLOCK_DEVICE}" "${actual_source}" &&
    [ "${actual_fsroot}" = "${expected_fsroot}" ]; then
    return 0
  fi
  if [ "${actual_source}" = "${BLOCK_DEVICE}[${expected_fsroot}]" ]; then
    return 0
  fi

  if command -v readlink >/dev/null 2>&1; then
    device_real="$(readlink -f "${BLOCK_DEVICE}" 2>/dev/null || true)"
    if [ -n "${device_real}" ] &&
      [ "${actual_source}" = "${device_real}[${expected_fsroot}]" ]; then
      return 0
    fi
  fi

  return 1
}

block_mount_options_include_mode() {
  options="$1"
  mode="$2"
  case ",${options}," in
    *",${mode},"*) return 0 ;;
    *) return 1 ;;
  esac
}

block_verify_mount_source() {
  target="$1"
  expected_source="$2"
  actual_source="$3"

  if ! block_sources_match "${expected_source}" "${actual_source}"; then
    block_die "${target} is mounted from ${actual_source}; expected ${expected_source}"
  fi
}

block_verify_mount_mode() {
  target="$1"
  expected_mode="$2"
  actual_options="$3"

  if ! block_mount_options_include_mode "${actual_options}" "${expected_mode}"; then
    block_die "${target} is mounted with options ${actual_options}; expected ${expected_mode}"
  fi
}

block_mount_root() {
  block_ensure_dir "${BLOCK_ROOT}"
  if block_find_mount_details "${BLOCK_ROOT}"; then
    block_verify_mount_source "${BLOCK_ROOT}" "${BLOCK_DEVICE}" "${BLOCK_MOUNT_SOURCE}"
    block_verify_mount_mode "${BLOCK_ROOT}" "rw" "${BLOCK_MOUNT_OPTIONS}"
    block_log "${BLOCK_ROOT} is already mounted"
    return 0
  fi
  mount "${BLOCK_DEVICE}" "${BLOCK_ROOT}"
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
