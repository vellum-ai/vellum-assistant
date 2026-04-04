#!/usr/bin/env bash
#
# Retry Docker Hub login up to N times with a delay between attempts.
# Usage: docker-login-with-retry.sh
#
# Required environment variables:
#   DOCKERHUB_USER            – Docker Hub username
#   DOCKERHUB_ACCESS_TOKEN    – Docker Hub access token / password
#
# Optional environment variables:
#   MAX_ATTEMPTS              – Number of login attempts (default: 3)
#   RETRY_WAIT_SECONDS        – Seconds to wait between retries (default: 10)

set -euo pipefail

MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
RETRY_WAIT_SECONDS="${RETRY_WAIT_SECONDS:-10}"

if [ -z "${DOCKERHUB_USER:-}" ] || [ -z "${DOCKERHUB_ACCESS_TOKEN:-}" ]; then
  echo "ERROR: DOCKERHUB_USER and DOCKERHUB_ACCESS_TOKEN must be set" >&2
  exit 1
fi

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "Docker Hub login attempt $attempt/$MAX_ATTEMPTS..."
  if echo "$DOCKERHUB_ACCESS_TOKEN" | docker login -u "$DOCKERHUB_USER" --password-stdin 2>&1; then
    echo "Docker Hub login succeeded on attempt $attempt"
    exit 0
  fi

  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    echo "Login failed, retrying in ${RETRY_WAIT_SECONDS}s..."
    sleep "$RETRY_WAIT_SECONDS"
  fi
done

echo "ERROR: Docker Hub login failed after $MAX_ATTEMPTS attempts" >&2
exit 1
