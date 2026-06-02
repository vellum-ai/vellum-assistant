#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "${SCRIPT_DIR}/vellum-block-volume-common.sh"

block_print_resize_evidence() {
  path="$1"
  [ -n "${path}" ] || return 0

  findmnt --target "${path}"
  df -h "${path}"
}

block_validate_mode_env
block_init_defaults

evidence_path="${VELLUM_BLOCK_RESIZE_EVIDENCE_PATH:-}"
if [ "$#" -gt 1 ]; then
  block_die "usage: vellum-block-volume-resize.sh [bind-path]"
fi
if [ "$#" -eq 1 ]; then
  evidence_path="$1"
fi
if [ -n "${evidence_path}" ]; then
  evidence_path="$(block_normalize_target_path "${evidence_path}")"
fi

block_wait_for_device

fs_type="$(block_detect_fs_type)"
case "${fs_type}" in
  ext4)
    ;;
  '')
    block_die "${BLOCK_DEVICE} contains no filesystem; expected ext4"
    ;;
  *)
    block_die "${BLOCK_DEVICE} contains unsupported filesystem '${fs_type}'; expected ext4"
    ;;
esac

resize2fs "${BLOCK_DEVICE}"
block_print_resize_evidence "${evidence_path}"
