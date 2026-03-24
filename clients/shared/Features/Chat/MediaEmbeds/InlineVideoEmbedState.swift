import Foundation

/// Lifecycle states for an inline video embed player.
///
/// Transitions: placeholder → initializing → playing (or failed).
/// A reset from any state returns to placeholder.
public enum InlineVideoEmbedState: Equatable {
    case placeholder
    case initializing
    case playing
    case failed(String)
}

/// Drives the UI state for a single inline video embed.
///
/// All mutations are main-actor–isolated because the state
/// feeds directly into SwiftUI views.
@MainActor
@Observable
public final class InlineVideoEmbedStateManager {
    public private(set) var state: InlineVideoEmbedState = .placeholder

    public init() {}

    /// Request the transition from placeholder (or failed) to initializing.
    ///
    /// Ignored when already initializing or playing — tapping play
    /// on an active player is a no-op.
    public func requestPlay() {
        switch state {
        case .placeholder, .failed:
            state = .initializing
        case .initializing, .playing:
            break
        }
    }

    public func didStartPlaying() {
        state = .playing
    }

    public func didFail(_ message: String) {
        state = .failed(message)
    }

    public func reset() {
        state = .placeholder
    }
}
