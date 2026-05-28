#!/usr/bin/env bash
# Fetch the LongMemEval-V2 dataset from Hugging Face into this directory.
#
# The dataset is ~7.12 GB and stays gitignored. This script is idempotent:
# re-running skips already-downloaded files (huggingface-cli compares by hash).
#
# Defaults:
#   - target dir: this script's parent (i.e. evals/benchmarks/longmemeval-v2/data/)
#   - repo:       xiaowu0162/longmemeval-v2
#
# Override via env: DATA_ROOT=... REPO=...
#
# Requires: huggingface-cli (`pip install -U "huggingface_hub[cli]"`).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_ROOT="${DATA_ROOT:-$SCRIPT_DIR}"
REPO="${REPO:-xiaowu0162/longmemeval-v2}"

if ! command -v huggingface-cli >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: huggingface-cli not found on PATH.

Install it with:
  pip install -U "huggingface_hub[cli]"

Then re-run this script.
EOF
  exit 1
fi

echo "Downloading $REPO into $DATA_ROOT ..."
huggingface-cli download "$REPO" \
  --repo-type dataset \
  --local-dir "$DATA_ROOT"

echo
echo "Done. Top-level files:"
ls -1 "$DATA_ROOT" | grep -v -E '^(\.gitignore|download\.sh)$' | head -20

cat <<EOF

Next steps:
  - Optional: extract trajectory screenshots
      mkdir -p "$DATA_ROOT/screenshots"
      tar -xzf "$DATA_ROOT/trajectory_screenshots/web_screenshots.tar.gz" \\
              -C "$DATA_ROOT/screenshots"
      tar -xzf "$DATA_ROOT/trajectory_screenshots/enterprise_screenshots_base.tar.gz" \\
              -C "$DATA_ROOT/screenshots"
  - Validate (optional): sha256sum -c "$DATA_ROOT/checksums.sha256"

The loader (\`src/loader.ts\`) reads:
  - questions.jsonl
  - haystacks/lme_v2_{small,medium}.json

trajectories.jsonl and *_screenshots/ are consumed by the runner, not the loader.
EOF
