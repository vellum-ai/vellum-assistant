# Clients - Agent Guidance

## Scope and precedence
- Applies to all client code in `clients/` (macOS, iOS, iPadOS, watchOS, tvOS, browser extensions, shared).
- Platform-specific docs (for example `clients/macos/CLAUDE.md`, `clients/ios/README.md`) override or extend this file.
- `AGENTS.md` at repo root still applies; if guidance conflicts, follow the most specific document.

## Research protocol (Apple platform work)
- Verify decisions against current Apple sources (Developer Documentation, HIG, WWDC sessions, Swift Evolution).
- Check deprecations and availability for targeted OS versions before adopting APIs.
- Prefer Apple-recommended patterns for SwiftUI, concurrency, accessibility, privacy, and app lifecycle.
- Note in the PR summary or commit message: `Apple refs checked (YYYY-MM-DD): ...`.
- If guidance is ambiguous, include a short rationale in the PR summary.

## SwiftUI + Apple platform practices (guidance)
- Follow SwiftUI data flow and state ownership; keep state minimal and localized.
- Keep UI work on the main actor; use async/await and structured concurrency when possible.
- Avoid deprecated APIs; use availability checks for multi-platform code.
- Respect HIG defaults for layout, typography, and controls; only customize when user value is clear.
- Accessibility is required: labels for icon-only controls, Dynamic Type support, VoiceOver-friendly order.
- Localize user-facing strings; format dates/units with locale-aware formatters.
- Performance: avoid heavy work in view bodies; prefer lazy containers for large lists; measure before optimizing.
- Privacy: request the minimum permissions; never log sensitive user content.

## Non-Apple clients
- Follow platform-specific best practices for the target (for example, Chrome extension guidelines).
- Keep shared client logic in `clients/shared` when it is platform-agnostic.

## Architecture and shared code
- Put cross-platform logic in `clients/shared`.
- Do not introduce platform-specific dependencies into shared targets.
- Prefer dependency injection for platform services to keep logic testable.

## Testing and quality
- Add or update tests when behavior changes; favor the testing patterns already used in that client.
- Keep builds and linting clean; run relevant tests when feasible.

## Maintenance
- Refresh this guidance after major Apple OS or SwiftUI releases (for example, post-WWDC).
