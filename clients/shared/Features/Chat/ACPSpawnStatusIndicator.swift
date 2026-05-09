import SwiftUI

// MARK: - ACPSpawnStatusIndicator

/// Render decision for the leading status indicator on the inline
/// `acp_spawn` deep-link row used by both macOS (`ACPSpawnStatusDot`
/// inside `AssistantProgressView.swift`) and iOS
/// (`ACPSpawnStatusIndicatorView` inside `ToolCallProgressBar.swift`).
/// Resolved as a pure function from the live store status (when present)
/// so unit tests can pin-point each visual state without standing up the
/// SwiftUI view tree, and so both platforms render the same lifecycle
/// from the same input.
///
/// Lives in `clients/shared/` so the macOS dot view and the iOS indicator
/// view consume one canonical resolver — previously each platform had its
/// own subtly different contract (iOS read `ToolCallData.isComplete` /
/// `isError` directly, ignoring the live `ACPSessionStore`, so it missed
/// running → completed transitions and the "history cleared while running"
/// edge case the macOS resolver covers).
public enum ACPSpawnStatusIndicator: Equatable {
    /// The session is still working — render a pulsing dot. Both
    /// `.running` and `.initializing` map to this state since neither is a
    /// terminal stop condition the user can act on.
    case pulsing
    /// The session reached a terminal state — render a static glyph in
    /// the supplied semantic role. Color is derived from the role at
    /// render time so the resolver can stay UI-framework-agnostic.
    case icon(glyph: Glyph, role: Role)

    public enum Glyph: Equatable {
        case check
        case xmark
        case dash

        /// Lucide glyph backing this case. Lives on the enum so both
        /// platforms render the same icon for the same state.
        public var icon: VIcon {
            switch self {
            case .check: return .circleCheck
            case .xmark: return .circleX
            case .dash: return .circleDashed
            }
        }
    }

    public enum Role: Equatable {
        /// Successful terminal — green check.
        case positive
        /// Errored terminal — red x.
        case negative
        /// Cancelled / unknown / muted terminal — gray dash.
        case muted

        /// Semantic color for this role. Lives on the enum so both
        /// platforms apply the same tone to the same state.
        public var color: Color {
            switch self {
            case .positive: return VColor.primaryBase
            case .negative: return VColor.systemNegativeStrong
            case .muted: return VColor.contentTertiary
            }
        }
    }

    /// Map a live ``ACPSessionState/Status`` into a render decision.
    /// Falls back to a muted dashed glyph when the store has no entry for
    /// the session id (`status` is nil). Two distinct cases land here and
    /// neither warrants a positive terminal check: (1) the store hasn't
    /// yet observed the `acp_session_spawned` event for a freshly spawned
    /// session — claiming "completed" in that race window would be wrong
    /// and would visibly flip backward to pulsing once the entry arrives;
    /// (2) history was cleared after a successful run — the spawn tool
    /// itself did succeed, but we can no longer prove the session's
    /// terminal disposition. A muted indeterminate glyph honestly conveys
    /// "we don't know" without pulsing indefinitely on a stale id.
    public static func resolve(forStatus status: ACPSessionState.Status?) -> ACPSpawnStatusIndicator {
        guard let status else {
            return .icon(glyph: .dash, role: .muted)
        }
        switch status {
        case .running, .initializing:
            return .pulsing
        case .completed:
            return .icon(glyph: .check, role: .positive)
        case .failed:
            return .icon(glyph: .xmark, role: .negative)
        case .cancelled:
            return .icon(glyph: .dash, role: .muted)
        case .unknown:
            // Daemon version skew — treat as completed so the inline
            // block matches the spawn tool's own "we got back a session
            // id" semantics rather than stalling on a ghost pulse.
            return .icon(glyph: .check, role: .positive)
        }
    }

    /// Tool-call-only fallback used when no live store entry exists yet
    /// (early launch, test harness, missing bridge). Mirrors the
    /// pre-shared iOS behavior so a row that lands before the store is
    /// wired still renders a sensible terminal glyph the moment the tool
    /// call itself finishes. Callers should prefer ``resolve(forStatus:)``
    /// against the live store and fall back to this only when the store
    /// lookup yields no entry.
    public static func resolve(forToolCall toolCall: ToolCallData) -> ACPSpawnStatusIndicator {
        if toolCall.isError {
            return .icon(glyph: .xmark, role: .negative)
        }
        if toolCall.isComplete {
            return .icon(glyph: .check, role: .positive)
        }
        return .pulsing
    }
}
