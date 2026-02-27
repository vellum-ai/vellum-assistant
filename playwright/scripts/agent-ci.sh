#!/usr/bin/env bash
#
# Trigger the Playwright agent tests in CI and optionally follow the run.
#
# Usage:
#   ./scripts/agent-ci.sh        # trigger + poll until done
#   ./scripts/agent-ci.sh -d     # trigger + print URL, then exit

set -euo pipefail

REPO="vellum-ai/vellum-assistant"
WORKFLOW="playwright.yaml"
DETACH=false

while getopts "d" opt; do
  case "$opt" in
    d) DETACH=true ;;
    *) echo "Usage: $0 [-d]" >&2; exit 1 ;;
  esac
done

# Trigger the workflow
echo "Triggering $WORKFLOW with agent=true..."
gh workflow run "$WORKFLOW" -R "$REPO" -f agent=true

# Give GitHub a moment to register the run
sleep 3

# Find the run we just created
RUN_ID=$(gh run list -R "$REPO" -w "$WORKFLOW" --limit 1 --json databaseId --jq '.[0].databaseId')

if [ -z "$RUN_ID" ]; then
  echo "Error: could not find the triggered run" >&2
  exit 1
fi

RUN_URL="https://github.com/$REPO/actions/runs/$RUN_ID"

if [ "$DETACH" = true ]; then
  echo ""
  echo "Run triggered: $RUN_URL"
  echo ""
  echo "To follow progress:"
  echo "  gh run watch $RUN_ID -R $REPO"
  exit 0
fi

echo "Run: $RUN_URL"
echo ""

# Poll until complete
gh run watch "$RUN_ID" -R "$REPO" --exit-status && STATUS=0 || STATUS=$?

# Print summary
echo ""
echo "─────────────────────────────────────────"
gh run view "$RUN_ID" -R "$REPO" --json conclusion,displayTitle,updatedAt \
  --jq '"Result: \(.conclusion)  (\(.displayTitle))\nFinished: \(.updatedAt)"'
echo "URL: $RUN_URL"
echo "─────────────────────────────────────────"

# Download artifacts if any
ARTIFACTS=$(gh run view "$RUN_ID" -R "$REPO" --json artifacts --jq '.artifacts | length')
if [ "$ARTIFACTS" -gt 0 ]; then
  echo ""
  echo "Downloading artifacts..."
  gh run download "$RUN_ID" -R "$REPO" -D playwright/test-results/ci-artifacts
  echo "Saved to playwright/test-results/ci-artifacts/"
fi

exit $STATUS
