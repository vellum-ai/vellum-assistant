#!/usr/bin/env bash
#
# bench-join-latency.sh
#
# Measure meet-bot join latency on an arm64 host running the amd64 bot image
# under qemu emulation. Runs the bot image N times against the given Meet URL,
# records wall-clock time from container start to the key bot-boot markers,
# and emits a CSV plus aggregate stats (mean / median / p95).
#
# The bot's lifecycle events (`lifecycle:joining`, `lifecycle:joined`) are
# shipped over an HTTP pipe to the daemon rather than being logged to stderr,
# so this script grep-anchors on the two stdout markers that are emitted in
# the clear at the relevant boot phases:
#
#   - "meet-bot booted"     — PulseAudio is up, pre-Xvfb/pre-browser boot
#                              checkpoint. Treated as JOIN_SENT proxy:
#                              everything after this is qemu-emulated CPU
#                              work (Chromium launch, extension load,
#                              prejoin DOM wait).
#   - "meet-bot ready (meetingId=..."  — extension has loaded, join command
#                                         dispatched, HTTP server started.
#                                         Treated as ADMITTED proxy.
#
# The two proxies are NOT identical to the on-wire `meet.joining` / `meet.joined`
# events — those fire strictly later (joined is posted after the extension
# confirms admission via `lifecycle:joined`). But for the qemu/arm64
# emulation-overhead baseline this script exists to measure, the bot-boot
# window is the dominant cost and the right thing to chart.
#
# Usage:
#   BOT_IMAGE=vellum-meet-bot:latest \
#     bench-join-latency.sh https://meet.google.com/xxx-yyyy-zzz [iterations]
#
# Env:
#   BOT_IMAGE     (required)  Container image reference.
#   MEETING_ID    (optional)  Overrides the generated per-run UUID.
#   JOIN_NAME     (optional)  Display name (default "Bench Bot").
#   BENCH_TIMEOUT (optional)  Per-iteration timeout seconds (default 120).
#   DAEMON_URL    (optional)  Dummy ingress URL. A dead URL is fine — the
#                             bot's daemon-client retries in the background
#                             and we don't need the events to land, we only
#                             need the bot to boot and dispatch the join.
#                             Default: http://127.0.0.1:1/ (always fails).
#
# Exits non-zero if BOT_IMAGE is unset or the Meet URL is missing.
#
set -euo pipefail

MEET_URL="${1:-}"
ITERATIONS="${2:-5}"

if [[ -z "${MEET_URL}" ]]; then
  echo "usage: $0 <meet-url> [iterations]" >&2
  exit 2
fi
if [[ -z "${BOT_IMAGE:-}" ]]; then
  echo "BOT_IMAGE env var is required (e.g. vellum-meet-bot:latest)" >&2
  exit 2
fi

JOIN_NAME="${JOIN_NAME:-Bench Bot}"
BENCH_TIMEOUT="${BENCH_TIMEOUT:-120}"
DAEMON_URL="${DAEMON_URL:-http://127.0.0.1:1/}"

# Portable milliseconds-since-epoch. `date +%s%3N` works on GNU coreutils
# (Linux, or macOS with `gdate` from `brew install coreutils`). Otherwise
# fall back to perl which is ubiquitous on macOS and every Linux distro
# we care about.
now_ms() {
  if date +%s%3N >/dev/null 2>&1 && [[ "$(date +%N 2>/dev/null)" != "N" ]]; then
    date +%s%3N
  elif command -v gdate >/dev/null 2>&1; then
    gdate +%s%3N
  else
    perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'
  fi
}

# Tiny random UUID-ish string for MEETING_ID when the caller didn't pin one.
gen_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    # Fallback: 32 hex chars from /dev/urandom.
    head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Scan a log file for the first line containing the marker, return the
# wall-clock ms at which it appeared. Returns empty string if the marker
# is never seen before EOF.
wait_for_marker() {
  local log_path="$1"
  local marker="$2"
  local deadline_ms="$3"
  while :; do
    if grep -qF -- "${marker}" "${log_path}" 2>/dev/null; then
      now_ms
      return 0
    fi
    if (( $(now_ms) > deadline_ms )); then
      echo ""
      return 1
    fi
    sleep 0.1
  done
}

echo "# bench-join-latency.sh" >&2
echo "# image=${BOT_IMAGE} iterations=${ITERATIONS} meet_url=${MEET_URL}" >&2
echo "# timeout=${BENCH_TIMEOUT}s daemon_url=${DAEMON_URL}" >&2
echo "iteration,start_ms,booted_ms,ready_ms,total_ms,booted_delta_ms,ready_delta_ms"

# Arrays for aggregate math.
declare -a booted_deltas=()
declare -a ready_deltas=()

# Track the currently-running container id so the EXIT trap can kill it if
# the script is interrupted (Ctrl-C, set -e failure) before the iteration
# clean-up runs. Otherwise a detached bot keeps burning CPU and skews later
# runs on the same host.
container_id=""
cleanup() {
  if [[ -n "${container_id}" ]]; then
    docker kill "${container_id}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${log_file:-}" ]]; then
    rm -f "${log_file}"
  fi
}
trap cleanup EXIT

for ((i = 1; i <= ITERATIONS; i++)); do
  meeting_id="${MEETING_ID:-$(gen_id)}"
  log_file="$(mktemp -t bench-join-latency-XXXXXX.log)"

  start_ms="$(now_ms)"
  deadline_ms=$(( start_ms + BENCH_TIMEOUT * 1000 ))

  # Launch the bot in the background with stdout+stderr tee'd to a temp file
  # so we can grep for markers while the container is still running.
  # `--init` ensures PID 1 handles SIGTERM cleanly.
  container_id="$(
    docker run -d --rm \
      --platform linux/amd64 \
      --init \
      -e "MEET_URL=${MEET_URL}" \
      -e "MEETING_ID=${meeting_id}" \
      -e "JOIN_NAME=${JOIN_NAME}" \
      -e "CONSENT_MESSAGE=This meeting is being recorded by a bot for benchmark purposes." \
      -e "DAEMON_URL=${DAEMON_URL}" \
      -e "BOT_API_TOKEN=bench-token-unused" \
      "${BOT_IMAGE}"
  )"

  # Tail the container's combined log stream into our temp file in the
  # background. `docker logs -f` blocks until the container exits.
  docker logs -f "${container_id}" >"${log_file}" 2>&1 &
  logs_pid=$!

  booted_ms="$(wait_for_marker "${log_file}" "meet-bot booted" "${deadline_ms}" || true)"
  ready_ms="$(wait_for_marker "${log_file}" "meet-bot ready (meetingId=" "${deadline_ms}" || true)"

  # SIGTERM the container; the bot's signal handler will drain & exit.
  docker kill --signal=SIGTERM "${container_id}" >/dev/null 2>&1 || true
  # Best-effort wait for graceful exit, bounded so a wedged container
  # doesn't stall the bench. If it doesn't exit in 15s, force-kill.
  for _ in $(seq 1 150); do
    if ! docker inspect "${container_id}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  docker kill "${container_id}" >/dev/null 2>&1 || true
  wait "${logs_pid}" 2>/dev/null || true

  end_ms="$(now_ms)"

  total_ms=$(( end_ms - start_ms ))
  booted_delta=""
  ready_delta=""
  if [[ -n "${booted_ms}" ]]; then
    booted_delta=$(( booted_ms - start_ms ))
    booted_deltas+=("${booted_delta}")
  fi
  if [[ -n "${ready_ms}" ]]; then
    ready_delta=$(( ready_ms - start_ms ))
    ready_deltas+=("${ready_delta}")
  fi

  printf "%d,%d,%s,%s,%d,%s,%s\n" \
    "${i}" \
    "${start_ms}" \
    "${booted_ms:-}" \
    "${ready_ms:-}" \
    "${total_ms}" \
    "${booted_delta:-}" \
    "${ready_delta:-}"

  rm -f "${log_file}"
  log_file=""
  container_id=""
done

# ---------------------------------------------------------------------------
# Aggregate stats
# ---------------------------------------------------------------------------

aggregate() {
  local label="$1"
  shift
  local -a vals=("$@")
  local n="${#vals[@]}"
  if (( n == 0 )); then
    echo "# ${label}: no samples" >&2
    return
  fi
  # Sort ascending for median / p95.
  local sorted
  sorted="$(printf "%s\n" "${vals[@]}" | sort -n)"
  local sum=0
  local v
  while IFS= read -r v; do
    sum=$(( sum + v ))
  done <<<"${sorted}"
  local mean=$(( sum / n ))
  # 1-indexed median / p95 offsets.
  local median_idx p95_idx
  median_idx=$(( (n + 1) / 2 ))
  # Ceil(0.95 * n), clamped to >= 1 and <= n.
  p95_idx=$(( (95 * n + 99) / 100 ))
  if (( p95_idx < 1 )); then p95_idx=1; fi
  if (( p95_idx > n )); then p95_idx=$n; fi
  local median p95
  median="$(echo "${sorted}" | sed -n "${median_idx}p")"
  p95="$(echo "${sorted}" | sed -n "${p95_idx}p")"
  echo "# ${label}: n=${n} mean=${mean}ms median=${median}ms p95=${p95}ms" >&2
}

# Guarded expansion: bash < 4.4 (macOS default bash 3.2) errors under `set -u`
# when `"${arr[@]}"` expands an empty array, so use `${arr+"${arr[@]}"}` to
# pass zero args when the array has no elements. `ready_deltas` in particular
# is often empty when iterations time out before the readiness marker.
aggregate "booted_delta (start → meet-bot booted)" ${booted_deltas+"${booted_deltas[@]}"}
aggregate "ready_delta  (start → meet-bot ready)" ${ready_deltas+"${ready_deltas[@]}"}
