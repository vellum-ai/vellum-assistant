#!/usr/bin/env sh

vellum_is_kata_family_runtime() {
  case "${VELLUM_SANDBOX_RUNTIME:-}" in
    kata|firecracker|cloud-hypervisor)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}
