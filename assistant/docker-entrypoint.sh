#!/usr/bin/env sh
set -eu

# Ensure /tmp has the standard sticky-bit world-writable mode so non-root
# processes (the `assistant` user, bun's tmpdir, scratch writes) can use it.
chmod 1777 /tmp 2>/dev/null || true

KATA_APT_INIT_PID=""
. /app/assistant/docker-kata-runtime-family.sh

if vellum_is_kata_family_runtime && [ -x /app/assistant/docker-init-apt-root.sh ]; then
  export VELLUM_APT_DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"
  # Warm the chroot used by Kata-family apt wrappers without blocking assistant readiness.
  /app/assistant/docker-init-apt-root.sh &
  KATA_APT_INIT_PID="$!"
fi

wait_for_kata_apt_root() {
  if [ -n "${KATA_APT_INIT_PID}" ]; then
    wait "${KATA_APT_INIT_PID}"
    KATA_APT_INIT_PID=""
  fi
}

if [ "$(id -u)" = "0" ] && [ "${VELLUM_WORKSPACE_DIR:-}" = "/workspace" ] && [ -d /workspace ]; then
  git config --global --add safe.directory /workspace >/dev/null 2>&1 || true
  git config --global --add safe.directory '/workspace/*' >/dev/null 2>&1 || true
fi

# Source workspace entrypoint hooks from /workspace/.entrypoint.d/ in
# lexicographic order. Hooks must be regular files (symlinks are rejected)
# and have the executable bit set. Scripts are sourced so env mutations
# propagate to the daemon. Errors are logged but non-fatal.
if [ -d /workspace/.entrypoint.d ]; then
  for hook in /workspace/.entrypoint.d/*.sh; do
    [ ! -L "$hook" ] || continue
    [ -x "$hook" ] || continue
    wait_for_kata_apt_root
    [ ! -L "$hook" ] || continue
    [ -x "$hook" ] || continue
    . "$hook" || echo "Warning: workspace hook $hook exited $?" >&2
  done
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
