---
name: testing-macos-native
description: Test macOS/Swift native client code changes (clients/macos, clients/shared) when no Xcode or Swift toolchain is available. Use when verifying Swift code correctness from a Linux environment.
---

# Testing macOS/Swift Native Client Code

## Overview
The macOS client is a Swift/SwiftUI app under `clients/macos/` with shared code in `clients/shared/`. CI skips macOS builds and tests (no macOS build environment). The Devin Linux VM has no Swift toolchain or Xcode.

## What You CAN Test (Script-Based Verification)

Since you cannot compile or run Swift code, focus on verifiable logic using Python or shell scripts:

### 1. Regex Pattern Verification
When changes involve regex patterns (e.g., Sentry `failedRequestTargets`, URL matching), verify correctness with Python's `re` module:
- `NSRegularExpression` patterns are compatible with Python `re` syntax for common features (lookahead, anchors, character classes)
- Sentry SDK uses `NSRegularExpression.firstMatch(in:range:)` — equivalent to Python `re.search()`
- Test against comprehensive URL sets covering both positive (should match) and negative (should not match) cases
- Include edge cases: trailing slashes, query params, substrings that look similar but aren't endpoints

### 2. Math/Formula Verification
For algorithmic changes (backoff intervals, retry logic, timing calculations):
- Replicate the formula in Python and verify against documented expected values
- Test boundary conditions (0, 1, max, overflow)
- Verify caps/limits are applied correctly
- Check that override conditions (e.g., `isUpdateInProgress`) bypass the formula

### 3. Code Path Analysis
Use grep/Python scripts to verify structural correctness:
- All required reset/initialization points exist for state variables
- Configuration is applied at all init sites (e.g., `SentrySDK.start` blocks)
- Properties have correct annotations (`@ObservationIgnored`, etc.)
- No unexpected call sites exist that bypass the change

### 4. Sentry SDK Configuration
When modifying Sentry config (`failedRequestTargets`, `failedRequestStatusCodes`, etc.):
- Verify all `SentrySDK.start { }` init sites are updated (search with `grep -rn 'SentrySDK.start {' clients/`)
- There are typically 2 init sites: `AppDelegate.swift` (early crash capture) and `MetricKitManager.restartSentryInline()` (re-enable after settings toggle)
- Both must reference the same constants
- Ref: https://docs.sentry.io/platforms/apple/configuration/http-client-errors/

## What You CANNOT Test

- **Swift compilation** — no Swift toolchain on Linux
- **Unit tests** — `./build.sh test` requires Xcode
- **Runtime behavior** — cannot run the macOS app
- **Sentry event capture** — requires live SDK in running app
- **UI changes** — no macOS GUI environment

## Reporting

Always clearly state these limitations in test reports. The reviewer must verify:
1. Local Xcode build compiles without errors
2. Runtime behavior matches expectations (if applicable)
3. Post-deploy monitoring confirms the fix (for observability changes like Sentry filtering)

## CI Notes

- CI runs Socket Security + FlexFrame Lint (always pass for Swift-only changes)
- macOS Build and macOS Tests are skipped in CI
- No preview deployments for native client changes

## Devin Secrets Needed
None — script-based verification requires no credentials.
