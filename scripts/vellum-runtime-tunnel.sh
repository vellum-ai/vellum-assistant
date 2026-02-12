#!/usr/bin/env bash
#
# vellum-runtime-tunnel.sh — SSH tunnel helper for remote runtime HTTP access.
#
# Forwards a local TCP port to a remote Vellum runtime HTTP server via SSH.
# Designed for web local mode: set LOCAL_RUNTIME_URL to the forwarded port.
#
# Usage:
#   vellum-runtime-tunnel.sh start <ssh-host> [options]
#   vellum-runtime-tunnel.sh stop
#   vellum-runtime-tunnel.sh status
#   vellum-runtime-tunnel.sh print-env
#
# Options:
#   --local-port PORT    Local port to bind (default: 7821)
#   --remote-port PORT   Remote runtime HTTP port (default: 7821)

set -euo pipefail

DEFAULT_PORT=7821
PID_FILE="${HOME}/.vellum/runtime-tunnel.pid"
INFO_FILE="${HOME}/.vellum/runtime-tunnel.info"

die() { echo "error: $*" >&2; exit 1; }

ensure_dir() {
  mkdir -p "${HOME}/.vellum"
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    cat "$PID_FILE"
  fi
}

is_tunnel_process() {
  local pid="$1"
  # Verify the PID is an ssh process to avoid acting on reused PIDs.
  # On macOS, `ps -o comm=` returns the full path (e.g. /usr/bin/ssh),
  # while on Linux it returns just the command name (ssh).
  ps -p "$pid" -o comm= 2>/dev/null | grep -qE '(^|/)ssh$'
}

is_running() {
  local pid
  pid=$(read_pid)
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && is_tunnel_process "$pid"
}

cmd_start() {
  local ssh_host=""
  local local_port="$DEFAULT_PORT"
  local remote_port="$DEFAULT_PORT"

  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --local-port)
        local_port="$2"; shift 2 ;;
      --remote-port)
        remote_port="$2"; shift 2 ;;
      -*)
        die "unknown option: $1" ;;
      *)
        if [[ -z "$ssh_host" ]]; then
          ssh_host="$1"; shift
        else
          die "unexpected argument: $1"
        fi
        ;;
    esac
  done

  [[ -n "$ssh_host" ]] || die "usage: $0 start <ssh-host> [--local-port PORT] [--remote-port PORT]"

  if is_running; then
    echo "Tunnel already running (PID $(read_pid))"
    return 0
  fi

  ensure_dir

  echo "Starting SSH tunnel: localhost:${local_port} -> ${ssh_host}:${remote_port} ..."
  ssh -N \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -L "127.0.0.1:${local_port}:127.0.0.1:${remote_port}" \
    "$ssh_host" &
  local pid=$!

  # Wait for the tunnel to become usable. ExitOnForwardFailure=yes ensures SSH
  # exits if it cannot bind the local port, but we also need to wait for the
  # connection to be fully established before declaring success.
  local attempts=0
  local max_attempts=10
  while (( attempts < max_attempts )); do
    sleep 0.5
    if ! kill -0 "$pid" 2>/dev/null; then
      die "SSH tunnel process exited — check SSH connectivity and port availability"
    fi
    # Try connecting to the forwarded local port to confirm the tunnel is ready
    if (echo > /dev/tcp/127.0.0.1/"${local_port}") 2>/dev/null; then
      break
    fi
    (( ++attempts ))
  done

  if ! kill -0 "$pid" 2>/dev/null; then
    die "SSH tunnel process exited — check SSH connectivity and port availability"
  fi

  if (( attempts == max_attempts )); then
    echo "warning: tunnel process is running but forwarded port ${local_port} is not responding yet" >&2
  fi

  echo "$pid" > "$PID_FILE"
  cat > "$INFO_FILE" <<EOINFO
LOCAL_PORT="${local_port}"
REMOTE_PORT="${remote_port}"
SSH_HOST="${ssh_host}"
EOINFO

  echo "Tunnel running (PID ${pid})"
  echo "Set LOCAL_RUNTIME_URL=http://127.0.0.1:${local_port} for web local mode."
}

cmd_stop() {
  if ! is_running; then
    echo "No tunnel running."
    rm -f "$PID_FILE" "$INFO_FILE"
    return 0
  fi

  local pid
  pid=$(read_pid)
  echo "Stopping tunnel (PID ${pid}) ..."
  kill "$pid" 2>/dev/null || true
  rm -f "$PID_FILE" "$INFO_FILE"
  echo "Tunnel stopped."
}

cmd_status() {
  if is_running; then
    local pid
    pid=$(read_pid)
    echo "Tunnel running (PID ${pid})"
    if [[ -f "$INFO_FILE" ]]; then
      cat "$INFO_FILE"
    fi
  else
    echo "No tunnel running."
    rm -f "$PID_FILE" "$INFO_FILE"
  fi
}

cmd_print_env() {
  if ! is_running; then
    die "no tunnel running — start one first"
  fi

  if [[ ! -f "$INFO_FILE" ]]; then
    die "tunnel info file missing"
  fi

  # shellcheck source=/dev/null
  source "$INFO_FILE"
  echo "ASSISTANT_CONNECTION_MODE=local"
  echo "LOCAL_RUNTIME_URL=http://127.0.0.1:${LOCAL_PORT}"
}

case "${1:-}" in
  start)     shift; cmd_start "$@" ;;
  stop)      cmd_stop ;;
  status)    cmd_status ;;
  print-env) cmd_print_env ;;
  *)
    echo "Usage: $0 {start|stop|status|print-env}"
    echo ""
    echo "Commands:"
    echo "  start <ssh-host> [--local-port PORT] [--remote-port PORT]"
    echo "      Start an SSH tunnel to a remote Vellum runtime."
    echo "  stop"
    echo "      Stop the running tunnel."
    echo "  status"
    echo "      Check if a tunnel is running."
    echo "  print-env"
    echo "      Print env vars for web local mode."
    exit 1
    ;;
esac
