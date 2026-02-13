#!/bin/bash
set -e

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
    echo -e "${YELLOW}Installing fswatch via Homebrew...${NC}"
    brew install fswatch
fi

echo -e "${BLUE}👀 Watching for Swift file changes...${NC}"
echo -e "${YELLOW}Press Ctrl+C to stop${NC}"
echo ""

# Initial build and launch
echo -e "${BLUE}🔨 Initial build...${NC}"
./build.sh run
echo ""

# Watch for changes (watch directories, filter for .swift files)
fswatch -o \
    --exclude='\.build/' \
    --exclude='dist/' \
    --exclude='\.swiftpm/' \
    --exclude='\.git/' \
    --exclude='Package.resolved' \
    --include='\.swift$' \
    --exclude='.*' \
    --event Created \
    --event Updated \
    --latency 0.5 \
    vellum-assistant \
    vellum-assistant-app | while read -r _; do

    echo ""
    echo -e "${YELLOW}📝 Change detected - rebuilding...${NC}"

    if ./build.sh run; then
        echo -e "${GREEN}✅ Build successful${NC}"
    else
        echo -e "${RED}❌ Build failed${NC}"
    fi

    echo -e "${BLUE}👀 Watching...${NC}"
done
