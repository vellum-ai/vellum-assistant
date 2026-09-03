#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/install-link-cli.sh [OPTIONS]

Install the latest Stripe Link CLI with a portable Node.js LTS runtime.
The installer verifies Node.js against the official SHASUMS256.txt file and
keeps all files under one user-writable directory.

Options:
  --install-dir DIR  Installation root. Defaults to LINK_CLI_HOME, then the
                     Vellum workspace, then the user data directory.
  --help             Show this help.

Output:
  Writes one JSON object to stdout with the installed versions and command path.
  Progress and failed compatibility attempts are written to stderr.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

default_data_root() {
  if [[ -n "${VELLUM_WORKSPACE_DIR:-}" ]]; then
    printf '%s/tools\n' "$VELLUM_WORKSPACE_DIR"
  elif [[ -n "${XDG_DATA_HOME:-}" ]]; then
    printf '%s/vellum/tools\n' "$XDG_DATA_HOME"
  else
    printf '%s/.local/share/vellum/tools\n' "$HOME"
  fi
}

install_dir="${LINK_CLI_HOME:-$(default_data_root)/stripe-link-cli}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      [[ $# -ge 2 ]] || fail "--install-dir requires a value"
      install_dir="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

require_command curl
require_command python3
require_command tar
require_command uname

case "$(uname -m)" in
  x86_64|amd64) node_arch="x64" ;;
  aarch64|arm64) node_arch="arm64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

case "$(uname -s)" in
  Linux)
    node_platform="linux"
    node_index_target="linux-$node_arch"
    archive_suffix="tar.xz"
    tar_flags="-xJf"
    ;;
  Darwin)
    node_platform="darwin"
    node_index_target="osx-$node_arch-tar"
    archive_suffix="tar.gz"
    tar_flags="-xzf"
    ;;
  *)
    fail "portable installation supports Linux and macOS"
    ;;
esac

parent_dir=$(dirname "$install_dir")
mkdir -p "$parent_dir"
work_dir=$(mktemp -d "$parent_dir/.stripe-link-cli-install.XXXXXX")
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

index_file="$work_dir/node-index.json"
curl --fail --silent --show-error --location \
  https://nodejs.org/dist/index.json \
  --output "$index_file"

node_versions=()
while IFS= read -r node_version; do
  node_versions+=("$node_version")
done < <(
  python3 - "$index_file" "$node_index_target" <<'PY'
import json
import re
import sys

index_path, target = sys.argv[1:]
rows = json.load(open(index_path, encoding="utf-8"))
seen_majors = set()
for row in rows:
    version = row.get("version", "")
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", version):
        continue
    if not row.get("lts") or target not in row.get("files", []):
        continue
    major = version.split(".", 1)[0]
    if major in seen_majors:
        continue
    seen_majors.add(major)
    print(version)
PY
)

[[ ${#node_versions[@]} -gt 0 ]] || fail "no compatible Node.js LTS release found"

verify_checksum() {
  local checksum_file=$1
  local archive_name=$2
  local archive_dir=$3
  local expected actual

  expected=$(awk -v file="$archive_name" '$2 == file { print $1 }' "$checksum_file")
  [[ -n "$expected" ]] || return 1

  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$archive_dir/$archive_name" | awk '{ print $1 }')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$archive_dir/$archive_name" | awk '{ print $1 }')
  else
    fail "sha256sum or shasum is required to verify Node.js"
  fi

  [[ "$actual" == "$expected" ]]
}

selected_node=""
selected_link_cli=""
staged_install=""
for node_version in "${node_versions[@]}"; do
  printf 'Trying Node.js %s with the latest Stripe Link CLI...\n' "$node_version" >&2
  candidate="$work_dir/candidate-${node_version#v}"
  runtime_dir="$candidate/runtime/node"
  app_dir="$candidate/app"
  mkdir -p "$runtime_dir" "$app_dir"

  archive_name="node-$node_version-$node_platform-$node_arch.$archive_suffix"
  release_url="https://nodejs.org/dist/$node_version"
  if ! curl --fail --silent --show-error --location \
    "$release_url/SHASUMS256.txt" \
    --output "$candidate/SHASUMS256.txt"; then
    printf 'Node.js %s: checksum manifest download failed.\n' "$node_version" >&2
    continue
  fi
  if ! curl --fail --silent --show-error --location \
    "$release_url/$archive_name" \
    --output "$candidate/$archive_name"; then
    printf 'Node.js %s: runtime download failed.\n' "$node_version" >&2
    continue
  fi
  if ! verify_checksum "$candidate/SHASUMS256.txt" "$archive_name" "$candidate"; then
    printf 'Node.js %s: checksum verification failed.\n' "$node_version" >&2
    continue
  fi
  if ! tar "$tar_flags" "$candidate/$archive_name" -C "$runtime_dir" --strip-components=1; then
    printf 'Node.js %s: extraction failed.\n' "$node_version" >&2
    continue
  fi

  printf '{"private":true}\n' > "$app_dir/package.json"
  npm_command="$runtime_dir/bin/npm"
  node_command="$runtime_dir/bin/node"
  if ! link_cli_version=$(
    PATH="$runtime_dir/bin:$PATH" "$npm_command" view @stripe/link-cli version
  ); then
    printf 'Node.js %s: could not resolve the latest Link CLI version.\n' "$node_version" >&2
    continue
  fi
  if [[ ! "$link_cli_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
    printf 'Node.js %s: npm returned an invalid Link CLI version.\n' "$node_version" >&2
    continue
  fi
  if ! PATH="$runtime_dir/bin:$PATH" "$npm_command" install \
    --prefix "$app_dir" \
    --ignore-scripts \
    --omit=dev \
    --no-audit \
    --no-fund \
    "@stripe/link-cli@$link_cli_version" >&2; then
    printf 'Node.js %s: Link CLI installation failed.\n' "$node_version" >&2
    continue
  fi

  cli_entry="$app_dir/node_modules/@stripe/link-cli/dist/cli.js"
  if ! installed_version=$(NO_UPDATE_NOTIFIER=1 "$node_command" "$cli_entry" --version); then
    printf 'Node.js %s: Link CLI version smoke test failed.\n' "$node_version" >&2
    continue
  fi
  if [[ "$installed_version" != "$link_cli_version" ]]; then
    printf 'Node.js %s: expected Link CLI %s but found %s.\n' \
      "$node_version" "$link_cli_version" "$installed_version" >&2
    continue
  fi
  if ! NO_UPDATE_NOTIFIER=1 "$node_command" "$cli_entry" auth login --help >/dev/null; then
    printf 'Node.js %s: Link CLI login smoke test failed.\n' "$node_version" >&2
    continue
  fi

  rm -f "$candidate/$archive_name" "$candidate/SHASUMS256.txt"
  mkdir -p "$candidate/bin"
  cat > "$candidate/bin/link-cli" <<'EOF'
#!/bin/sh
install_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$install_root/runtime/node/bin/node" \
  "$install_root/app/node_modules/@stripe/link-cli/dist/cli.js" "$@"
EOF
  chmod 700 "$candidate/bin/link-cli"

  selected_node="$node_version"
  selected_link_cli="$link_cli_version"
  staged_install="$candidate"
  break
done

[[ -n "$staged_install" ]] || fail "the latest Link CLI failed on every available Node.js LTS release"

backup_dir="$parent_dir/.stripe-link-cli-backup.$$"
rm -rf "$backup_dir"
if [[ -e "$install_dir" ]]; then
  mv "$install_dir" "$backup_dir"
fi
if mv "$staged_install" "$install_dir"; then
  rm -rf "$backup_dir"
else
  if [[ -e "$backup_dir" ]]; then
    mv "$backup_dir" "$install_dir"
  fi
  fail "could not promote the verified Link CLI installation"
fi

command_path="$install_dir/bin/link-cli"
python3 - "$command_path" "$selected_node" "$selected_link_cli" "$install_dir" <<'PY'
import json
import sys

command, node_version, link_cli_version, install_dir = sys.argv[1:]
print(json.dumps({
    "command": command,
    "node_version": node_version,
    "link_cli_version": link_cli_version,
    "install_dir": install_dir,
}))
PY
