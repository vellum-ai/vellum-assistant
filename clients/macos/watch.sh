#!/bin/bash
set -euo pipefail

# Auto-rebuild and relaunch on file save
# Usage: ./watch.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if fswatch is installed
if ! command -v fswatch &> /dev/null; then
    if ! command -v brew &> /dev/null; then
        echo -e "${RED}Error: fswatch is required but not installed, and Homebrew is not available.${NC}"
        echo -e "Install fswatch manually: ${BLUE}https://github.com/emcrisostomo/fswatch${NC}"
        exit 1
    fi

    echo -e "${YELLOW}fswatch is not installed. Install it via Homebrew? (y/N)${NC}"
    read -r response
    if [[ "$response" =~ ^[Yy]$ ]]; then
        brew install fswatch
    else
        echo -e "${RED}fswatch is required for watch mode. Exiting.${NC}"
        exit 1
    fi
fi

echo -e "${BLUE}👀 Watching for Swift file changes...${NC}"
echo -e "${YELLOW}Press Ctrl+C to stop${NC}"
echo ""

# Initial build and launch
echo -e "${BLUE}🔨 Initial build...${NC}"
./build.sh run
echo ""

# Watch for changes (Swift files and resources)
# Use process substitution instead of pipe to avoid orphaning fswatch on Ctrl+C
BUILD_PID=""
while read -r _; do
    # Debounce: skip if a build is already running
    if [ -n "$BUILD_PID" ] && kill -0 "$BUILD_PID" 2>/dev/null; then
        echo -e "${YELLOW}⏭️  Change detected but build already in progress, skipping...${NC}"
        continue
    fi

    echo ""
    echo -e "${YELLOW}📝 Change detected - rebuilding...${NC}"

    # Run build in background to enable debouncing
    ./build.sh run &
    BUILD_PID=$!

    # Wait for build to complete
    if wait "$BUILD_PID"; then
        echo -e "${GREEN}✅ Build successful${NC}"
    else
        echo -e "${RED}❌ Build failed${NC}"
    fi
    BUILD_PID=""

    echo -e "${BLUE}👀 Watching...${NC}"
done < <(fswatch -o \
    --exclude='\.build/' \
    --exclude='dist/' \
    --exclude='\.swiftpm/' \
    --exclude='\.git/' \
    --include='\.swift$' \
    --include='\.png$' \
    --include='\.jpg$' \
    --include='\.jpeg$' \
    --include='\.svg$' \
    --include='\.json$' \
    --include='\.ttf$' \
    --include='\.otf$' \
    --include='\.xcassets/' \
    --exclude='.*' \
    --event Created \
    --event Updated \
    --event Removed \
    --latency 0.5 \
    vellum-assistant \
    vellum-assistant-app \
    Package.swift)
