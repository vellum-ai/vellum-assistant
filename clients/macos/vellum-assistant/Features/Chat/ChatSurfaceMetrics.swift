import Foundation
import os

// MARK: - Chat Surface Metrics Vocabulary

/// Shared, content-safe vocabulary for chat-surface instrumentation.
///
/// Provides standardized identifiers for the sources and interactions
/// that participate in chat-surface rendering so that downstream
/// signpost emission and diagnostics recording use a single canonical
/// set of names instead of ad-hoc strings.
enum ChatSurfaceMetrics {

    // MARK: - Source

    /// Identifies the architectural component that originated a metric event.
    enum Source: String, Codable, Sendable {
        case chatView
        case transcriptProjector
        case messageList
        case chatBubble
        case progressCard
        case composerController
        case composerTextBridge
        case scrollCoordinator
    }

    // MARK: - Interaction

    /// Identifies the user or system interaction that triggered the event.
    enum Interaction: String, Codable, Sendable {
        case send
        case stream
        case manualScroll
        case manualExpansion
        case emojiPopup
        case slashPopup
        case anchorJump
        case searchJump
    }

    // MARK: - Signpost Helpers

    /// Emits an `os_signpost` event on the shared Points of Interest log
    /// and records a diagnostic event in `ChatDiagnosticsStore`.
    ///
    /// - Parameters:
    ///   - source: The architectural component originating the event.
    ///   - interaction: The user/system interaction that triggered the event.
    ///   - kind: The diagnostic event kind to record.
    ///   - conversationId: The conversation associated with the event, if any.
    ///   - reason: A short, content-safe reason string.
    @MainActor
    static func emit(
        source: Source,
        interaction: Interaction,
        kind: ChatDiagnosticEventKind,
        conversationId: String? = nil,
        reason: String? = nil
    ) {
        let signpostName: StaticString = "chatSurface"
        os_signpost(
            .event,
            log: PerfSignposts.log,
            name: signpostName,
            "%{public}s.%{public}s",
            source.rawValue,
            interaction.rawValue
        )

        let event = ChatDiagnosticEvent(
            kind: kind,
            conversationId: conversationId,
            reason: reason,
            source: source,
            interaction: interaction
        )
        ChatDiagnosticsStore.shared.record(event)
    }

    /// Begins a signpost interval on the shared Points of Interest log.
    ///
    /// Returns an `OSSignpostID` that the caller passes to ``endInterval``
    /// when the measured region completes.
    static func beginInterval(
        source: Source,
        interaction: Interaction
    ) -> OSSignpostID {
        let id = OSSignpostID(log: PerfSignposts.log)
        os_signpost(
            .begin,
            log: PerfSignposts.log,
            name: "chatSurfaceInterval",
            signpostID: id,
            "%{public}s.%{public}s",
            source.rawValue,
            interaction.rawValue
        )
        return id
    }

    /// Ends a signpost interval previously started with ``beginInterval``.
    static func endInterval(_ signpostID: OSSignpostID) {
        os_signpost(
            .end,
            log: PerfSignposts.log,
            name: "chatSurfaceInterval",
            signpostID: signpostID
        )
    }
}
