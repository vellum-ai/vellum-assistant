import SwiftUI

// MARK: - ACPSpawnStatusIndicator

/// Render decision for the leading status indicator on the inline
/// `acp_spawn` deep-link row used by macOS (`ACPSpawnStatusDot` inside
/// `AssistantProgressView.swift`). Resolved as a pure function from the
/// live store status so unit tests can pin-point each visual state
/// without standing up the SwiftUI view tree.
///
/// Lives in `clients/shared/` because the macOS dot view consumes it
/// from the shared module.
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
}
