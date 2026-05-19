---
name: testing-chrome-ext-build
description: Test the Chrome extension build script end-to-end. Use when verifying build.sh changes, dependency installation, or TypeScript configuration.
---

# Testing Chrome Extension Build

## Overview

The Chrome extension lives at `clients/chrome-extension/`. It uses React + Tailwind + Vite, built via `build.sh`.

## Build Commands

```bash
cd clients/chrome-extension

# One-shot build (default env: dev)
bash build.sh build

# Build + watch mode (env: local)
bash build.sh run

# Release build (env: production)
bash build.sh release
```

## Key Architecture

- `build.sh` is self-contained: it installs its own dependencies via `bun install` before building (matching the pattern in `clients/macos/build.sh`)
- `setup.sh` does NOT install chrome-extension deps — client builds are expected to be self-contained
- `vel up` spawns `bash build.sh run` without any pre-install step
- CI workflows (`pr-chrome-extension.yaml`) have their own explicit `bun install --frozen-lockfile` step

## Test Scenarios

### 1. Build with no node_modules (fresh clone scenario)
```bash
rm -rf node_modules
bash build.sh build
# Expect: "Installing dependencies..." → packages installed → typecheck passes → build succeeds
```

### 2. Build with existing node_modules (idempotency)
```bash
bash build.sh build
# Expect: "no changes" from bun install (fast ~5ms no-op) → build succeeds
```

### 3. Build with partial node_modules
```bash
rm -rf node_modules/@types/react
bash build.sh build
# Expect: bun install restores missing package → build succeeds
```

## TypeScript Configuration Notes

- `tsconfig.json` uses `types: []` — this only controls global ambient type inclusion, NOT module resolution. It's correct and forward-looking (TypeScript 6.0 default).
- `jsx: "react-jsx"` auto-includes JSX types even with `types: []` (TypeScript PR #41330)
- `moduleResolution: "NodeNext"` is a deliberate repo-wide convention (all imports use `.js` extensions)

## Common Failure Modes

- **TS2307 / TS7026 / TS2875 errors**: Missing `node_modules` — `bun install` not run. If `build.sh` install step is missing or broken, these errors appear for all React/JSX types.
- **Typecheck passes but Vite fails**: Likely a Vite config issue, not a deps issue.

## Devin Secrets Needed

None — the build is entirely local with no external service dependencies.
