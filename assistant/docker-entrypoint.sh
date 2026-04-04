#!/usr/bin/env sh
set -eu

if [ "$(id -u)" = "0" ] && [ "${VELLUM_WORKSPACE_DIR:-}" = "/workspace" ] && [ -d /workspace ]; then
  git config --global --add safe.directory /workspace >/dev/null 2>&1 || true
  git config --global --add safe.directory '/workspace/*' >/dev/null 2>&1 || true
fi

# ── Bun profiler bootstrap ──────────────────────────────────────────────
# When VELLUM_PROFILER_RUN_ID and VELLUM_PROFILER_MODE are set, prepare the
# run directory on the workspace volume and append the appropriate Bun
# profiler flags to BUN_OPTIONS. Bun's native --cpu-prof / --heap-prof
# flags write Chrome-compatible .cpuprofile and .heapsnapshot artifacts.
BUN_OPTIONS="${BUN_OPTIONS:-}"

if [ -n "${VELLUM_PROFILER_RUN_ID:-}" ] && [ -n "${VELLUM_PROFILER_MODE:-}" ]; then
  PROFILER_WORKSPACE="${VELLUM_WORKSPACE_DIR:-$HOME/.vellum/workspace}"
  PROFILER_RUN_DIR="${PROFILER_WORKSPACE}/data/profiler/runs/${VELLUM_PROFILER_RUN_ID}"

  # Ensure the run directory exists
  mkdir -p "${PROFILER_RUN_DIR}"

  case "${VELLUM_PROFILER_MODE}" in
    cpu)
      BUN_OPTIONS="${BUN_OPTIONS} --cpu-prof --cpu-prof-md --cpu-prof-dir=${PROFILER_RUN_DIR}"
      ;;
    heap)
      BUN_OPTIONS="${BUN_OPTIONS} --heap-prof --heap-prof-md --heap-prof-dir=${PROFILER_RUN_DIR}"
      ;;
    cpu+heap|heap+cpu)
      BUN_OPTIONS="${BUN_OPTIONS} --cpu-prof --cpu-prof-md --cpu-prof-dir=${PROFILER_RUN_DIR} --heap-prof --heap-prof-md --heap-prof-dir=${PROFILER_RUN_DIR}"
      ;;
    *)
      echo "Warning: unknown VELLUM_PROFILER_MODE '${VELLUM_PROFILER_MODE}', skipping profiler flags" >&2
      ;;
  esac
fi

# shellcheck disable=SC2086
exec bun --smol ${BUN_OPTIONS} run src/daemon/main.ts
