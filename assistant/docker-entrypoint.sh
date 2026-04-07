#!/usr/bin/env sh
set -eu

if [ "$(id -u)" = "0" ] && [ "${VELLUM_WORKSPACE_DIR:-}" = "/workspace" ] && [ -d /workspace ]; then
  git config --global --add safe.directory /workspace >/dev/null 2>&1 || true
  git config --global --add safe.directory '/workspace/*' >/dev/null 2>&1 || true
fi

DEFAULT_GIT_NAME="${ASSISTANT_GIT_USER_NAME:-Vellum Assistant}"
DEFAULT_GIT_EMAIL="${ASSISTANT_GIT_USER_EMAIL:-assistant@vellum.ai}"

if ! git config --global --get user.name >/dev/null 2>&1; then
  git config --global user.name "${DEFAULT_GIT_NAME}" >/dev/null 2>&1 || true
fi

if ! git config --global --get user.email >/dev/null 2>&1; then
  git config --global user.email "${DEFAULT_GIT_EMAIL}" >/dev/null 2>&1 || true
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
  PROFILER_HEAP_DIR="${PROFILER_RUN_DIR}"

  # Ensure the run directory exists
  mkdir -p "${PROFILER_RUN_DIR}"

  # Bun resolves heap profile output more reliably when the directory is
  # expressed relative to the current working directory.
  if command -v realpath >/dev/null 2>&1; then
    PROFILER_HEAP_DIR="$(
      realpath --relative-to="$(pwd)" "${PROFILER_RUN_DIR}" 2>/dev/null ||
        printf '%s' "${PROFILER_RUN_DIR}"
    )"
  fi

  case "${VELLUM_PROFILER_MODE}" in
    cpu)
      BUN_OPTIONS="${BUN_OPTIONS} --cpu-prof --cpu-prof-md --cpu-prof-dir=${PROFILER_RUN_DIR}"
      ;;
    heap)
      BUN_OPTIONS="${BUN_OPTIONS} --heap-prof --heap-prof-md --heap-prof-dir=${PROFILER_HEAP_DIR}"
      ;;
    cpu+heap|heap+cpu)
      BUN_OPTIONS="${BUN_OPTIONS} --cpu-prof --cpu-prof-md --cpu-prof-dir=${PROFILER_RUN_DIR} --heap-prof --heap-prof-md --heap-prof-dir=${PROFILER_HEAP_DIR}"
      ;;
    *)
      echo "Warning: unknown VELLUM_PROFILER_MODE '${VELLUM_PROFILER_MODE}', skipping profiler flags" >&2
      ;;
  esac
fi

# shellcheck disable=SC2086
exec bun --smol ${BUN_OPTIONS} run src/daemon/main.ts
