#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_PATH="$ROOT_DIR/vellum-assistant.xcodeproj"
SCHEME="vellum-assistant"
CONFIGURATION="${CONFIGURATION:-Debug}"
DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-$ROOT_DIR/.dev/DerivedData}"
SOURCE_PACKAGES_PATH="${SOURCE_PACKAGES_PATH:-$ROOT_DIR/.dev/SourcePackages}"
TEAM_ID="${DEVELOPMENT_TEAM:-${VELLUM_DEVELOPMENT_TEAM:-}}"
BUILD_ONLY=0
CLEAN=0

usage() {
  cat <<'EOF'
Usage: scripts/run-dev.sh [options]

Builds a signed .app into a stable path and launches it.
This keeps macOS Privacy & Security permissions stable across rebuilds.

Options:
  --team <TEAM_ID>    Override Apple Developer team ID
  --derived-data <path>
                      Override DerivedData path (default: .dev/DerivedData)
  --build-only        Build only, do not launch
  --clean             Run a clean build
  -h, --help          Show this help
EOF
}

parse_team_from_local_xcconfig() {
  local local_xcconfig="$ROOT_DIR/Local.xcconfig"
  if [[ -f "$local_xcconfig" ]]; then
    awk -F= '/^[[:space:]]*DEVELOPMENT_TEAM[[:space:]]*=/ {
      gsub(/[[:space:]]/, "", $2)
      print $2
      exit
    }' "$local_xcconfig"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --team)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --team" >&2
        exit 1
      fi
      TEAM_ID="$2"
      shift 2
      ;;
    --derived-data)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --derived-data" >&2
        exit 1
      fi
      DERIVED_DATA_PATH="$2"
      shift 2
      ;;
    --build-only)
      BUILD_ONLY=1
      shift
      ;;
    --clean)
      CLEAN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$TEAM_ID" ]]; then
  TEAM_ID="$(parse_team_from_local_xcconfig || true)"
fi

APP_PATH="$DERIVED_DATA_PATH/Build/Products/$CONFIGURATION/vellum-assistant.app"

mkdir -p "$DERIVED_DATA_PATH"
mkdir -p "$SOURCE_PACKAGES_PATH"

build_cmd=(
  xcodebuild
  -project "$PROJECT_PATH"
  -scheme "$SCHEME"
  -configuration "$CONFIGURATION"
  -derivedDataPath "$DERIVED_DATA_PATH"
  -clonedSourcePackagesDirPath "$SOURCE_PACKAGES_PATH"
  -skipPackageUpdates
  CODE_SIGN_STYLE=Automatic
  CODE_SIGNING_ALLOWED=YES
  CODE_SIGNING_REQUIRED=YES
)

if [[ -n "$TEAM_ID" ]]; then
  build_cmd+=(DEVELOPMENT_TEAM="$TEAM_ID")
fi

if [[ $CLEAN -eq 1 ]]; then
  build_cmd+=(clean)
fi

build_cmd+=(build)

echo "Building $SCHEME ($CONFIGURATION)..."
if [[ -n "$TEAM_ID" ]]; then
  echo "Using DEVELOPMENT_TEAM=$TEAM_ID"
else
  echo "No DEVELOPMENT_TEAM provided; xcodebuild will use Xcode defaults."
fi

if ! DEVELOPER_DIR="$DEVELOPER_DIR" "${build_cmd[@]}"; then
  cat <<'EOF' >&2

Build failed.
If signing failed, set your team ID in one of these ways:
1) export DEVELOPMENT_TEAM=YOUR_TEAM_ID
2) set DEVELOPMENT_TEAM in Local.xcconfig
3) pass --team YOUR_TEAM_ID
EOF
  exit 1
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "Expected app bundle not found at: $APP_PATH" >&2
  exit 1
fi

echo "Built app at: $APP_PATH"

if [[ $BUILD_ONLY -eq 1 ]]; then
  exit 0
fi

pkill -x "vellum-assistant" >/dev/null 2>&1 || true
open "$APP_PATH"
echo "Launched vellum-assistant."
