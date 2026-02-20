#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ASSISTANT_DIR="$(cd "$CLI_DIR/../assistant" && pwd)"

cd "$CLI_DIR"
OLD_VERSION=$(node -p "require('./package.json').version")
npm version patch --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")

cd "$ASSISTANT_DIR"
npm pkg set "dependencies.@vellumai/cli=$NEW_VERSION"
sed -i "s/\"@vellumai\/cli\": \"[^\"]*\"/\"@vellumai\/cli\": \"$NEW_VERSION\"/g" bun.lock
sed -i "s/@vellumai\/cli@[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*/@vellumai\/cli@$NEW_VERSION/g" bun.lock
npm version patch --no-git-tag-version
