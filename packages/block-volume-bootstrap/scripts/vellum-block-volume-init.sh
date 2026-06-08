#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "${SCRIPT_DIR}/vellum-block-volume-common.sh"

block_prepare_top_level_dir() {
  name="$1"
  owner="$2"
  path="$(block_child_path "${name}")"
  block_ensure_dir "${path}"
  chown "${owner}" "${path}"
}

block_validate_mode_env
block_init_defaults
block_wait_for_device

fs_type="$(block_detect_fs_type)"
case "${fs_type}" in
  '')
    mkfs.ext4 -F "${BLOCK_DEVICE}"
    ;;
  ext4)
    block_log "${BLOCK_DEVICE} already contains an ext4 filesystem"
    "${SCRIPT_DIR}/vellum-block-volume-resize.sh"
    ;;
  *)
    block_die "${BLOCK_DEVICE} contains unsupported filesystem '${fs_type}'; expected ext4"
    ;;
esac

block_mount_root

block_prepare_top_level_dir "assistant-data" "1001:1001"
block_prepare_top_level_dir "workspace" "1001:1001"
block_prepare_top_level_dir "ces-data" "1001:1001"
block_prepare_top_level_dir "dockerd-data" "0:0"
