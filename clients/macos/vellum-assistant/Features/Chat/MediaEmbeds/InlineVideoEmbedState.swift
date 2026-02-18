import Foundation

/// Lifecycle states for an inline video embed player.
///
/// Transitions: placeholder → initializing → playing (or failed).
/// A reset from any state returns to placeholder.
enum InlineVideoEmbedState: Equatable {
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
final class InlineVideoEmbedStateManager: ObservableObject {
    @Published private(set) var state: InlineVideoEmbedState = .placeholder

    /// Request the transition from placeholder (or failed) to initializing.
    ///
    /// Ignored when already initializing or playing — tapping play
    /// on an active player is a no-op.
    func requestPlay() {
        switch state {
        case .placeholder, .failed:
            state = .initializing
        case .initializing, .playing:
            break
        }
    }

    func didStartPlaying() {
        state = .playing
    }

    func didFail(_ message: String) {
        state = .failed(message)
    }

    func reset() {
        state = .placeholder
    }
}
