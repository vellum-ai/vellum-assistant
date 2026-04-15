#!/usr/bin/env sh
set -eu

# ── dockerd supervisor (Docker-in-Docker) ──────────────────────────────
# When running inside the assistant container (IS_CONTAINERIZED=true),
# start an inner dockerd so the Meet subsystem can spawn nested bot
# containers via this container's own /var/run/docker.sock. Outside a
# container this script does not run (the bare-metal daemon uses the
# host's docker engine directly).
#
# The canonical runtime-mode signal is IS_CONTAINERIZED (see
# src/runtime/runtime-mode.ts / src/config/env-registry.ts). Truthy
# values are "true" or "1".
start_dockerd_if_containerized() {
  case "${IS_CONTAINERIZED:-}" in
    true|1) ;;
    *) return 0 ;;
  esac

  DOCKERD_LOG="/var/log/dockerd.log"
  mkdir -p /var/log

  # Prefer overlay2 for performance. If overlay2 fails to come up within
  # 30s (common when the outer storage driver doesn't support nested
  # overlay mounts, e.g. some CI runners), fall back to vfs.
  _try_start_dockerd() {
    _driver="$1"
    echo "[vellum-init] starting dockerd (--storage-driver=${_driver})" >&2

    # Kill any stale dockerd from a prior attempt.
    if [ -n "${DOCKERD_PID:-}" ] && kill -0 "${DOCKERD_PID}" 2>/dev/null; then
      kill "${DOCKERD_PID}" 2>/dev/null || true
      wait "${DOCKERD_PID}" 2>/dev/null || true
    fi

    # Start dockerd in the background. /etc/docker/daemon.json supplies
    # log-driver + log-opts; the storage driver is passed on the CLI so
    # the fallback path can override it without rewriting the config.
    dockerd --storage-driver="${_driver}" >>"${DOCKERD_LOG}" 2>&1 &
    DOCKERD_PID=$!

    # Poll /var/run/docker.sock for up to 30s (0.5s * 60).
    _i=0
    while [ "${_i}" -lt 60 ]; do
      if docker ps >/dev/null 2>&1; then
        echo "[vellum-init] dockerd ready (storage-driver=${_driver}, pid=${DOCKERD_PID})" >&2
        return 0
      fi

      # If dockerd already exited, bail out of this attempt immediately.
      if ! kill -0 "${DOCKERD_PID}" 2>/dev/null; then
        echo "[vellum-init] dockerd exited during startup (storage-driver=${_driver})" >&2
        DOCKERD_PID=""
        return 1
      fi

      _i=$((_i + 1))
      sleep 0.5
    done

    echo "[vellum-init] dockerd did not become ready within 30s (storage-driver=${_driver})" >&2
    return 1
  }

  DOCKERD_PID=""
  if _try_start_dockerd overlay2; then
    return 0
  fi

  echo "[vellum-init] overlay2 dockerd startup failed; falling back to vfs" >&2
  if _try_start_dockerd vfs; then
    return 0
  fi

  echo "[vellum-init] dockerd did not become ready within 30s; see ${DOCKERD_LOG}" >&2
  exit 1
}

start_dockerd_if_containerized

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
