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

echo -e "${BLUE}👀 Watching for file changes (Swift, resources, dependencies)...${NC}"
echo -e "${YELLOW}Press Ctrl+C to stop${NC}"
echo ""

# Initial build and launch
echo -e "${BLUE}🔨 Initial build...${NC}"
./build.sh run
echo ""

# Set up FIFO for fswatch communication (allows capturing PID for cleanup)
FIFO=$(mktemp -u)
mkfifo "$FIFO"
FSWATCH_PID=""

# Trap to clean up fswatch process and FIFO on exit
trap 'if [ -n "$FSWATCH_PID" ]; then kill $FSWATCH_PID 2>/dev/null; fi; rm -f "$FIFO"; exit' INT TERM

# Start fswatch as background process writing to FIFO
# This allows us to capture its PID for proper cleanup
    echo ""
    echo -e "${YELLOW}📝 Change detected - rebuilding...${NC}"

    # Run build synchronously
    if ./build.sh run; then
        echo -e "${GREEN}✅ Build successful${NC}"
    else
        echo -e "${RED}❌ Build failed${NC}"
    fi

    # Drain any events that accumulated during the build (debounce)
    # This prevents N rapid saves from triggering N sequential rebuilds
    # Note: Use integer timeout (bash 3.2 on macOS doesn't support fractional seconds)
    # read -r -t 1 returns exit code 1 on timeout, but bash exempts
    # commands in while conditions from set -e, so this is safe
    DRAINED=0
    while read -r -t 1 _; do
        DRAINED=$((DRAINED + 1))
    done
    if [ "$DRAINED" -gt 0 ]; then
        echo -e "${YELLOW}⏭️  Skipped $DRAINED buffered change(s) (coalesced)${NC}"
    fi

    echo -e "${BLUE}👀 Watching...${NC}"
done < "$FIFO" &

# Start fswatch in background, writing to FIFO, and capture its PID
fswatch -o \
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
    --include='\.xcassets' \
    --include='Package\.resolved$' \
    --exclude='.*' \
    --event Created \
    --event Updated \
    --event Removed \
    --latency 0.5 \
    vellum-assistant \
    vellum-assistant-app \
    daemon-bin \
    Package.swift \
    Package.resolved > "$FIFO" &
FSWATCH_PID=$!

# Wait for the read loop to finish (it runs in background via &)
wait
