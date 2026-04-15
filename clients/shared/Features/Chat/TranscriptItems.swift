import Foundation

// MARK: - Transcript Item

/// A single renderable item in the chat transcript after the queued-user-message
/// collapse has been applied. Consecutive queued user messages are represented
/// by a single `queuedMarker` placed at the position of the first collapsed
/// message in the original order.
///
/// - `message`: a regular chat message that should be rendered as a bubble.
/// - `queuedMarker`: a collapsed placeholder standing in for one or more
///   queued user messages. Its identity is `TranscriptItems.queueMarkerId`,
///   a constant sentinel UUID, so SwiftUI `ForEach` / animation diffing
///   treats the marker as the same view across queue mutations (e.g. when
///   the head of the queue dequeues and the "first queued message" id
///   would otherwise change). Mirrors the
///   `TranscriptProjector.thinkingPlaceholderId` pattern.
public enum TranscriptItem: Equatable, Identifiable {
    case message(ChatMessage)
    case queuedMarker(count: Int)

    public var id: UUID {
        switch self {
        case .message(let message):
            return message.id
        case .queuedMarker:
            return TranscriptItems.queueMarkerId
        }
    }
}

// MARK: - Transcript Items Builder

/// Pure helper that collapses inline queued user messages into a single marker
/// item. Cross-platform — the individual queued messages are still rendered
/// in the queue drawer (PR 5), so showing them as inline bubbles duplicates
/// the information and makes the transcript hard to read when many
/// follow-ups are queued.
///
/// The first queued user message (in iteration order) is replaced with a
/// `queuedMarker` whose `count` equals the total number of collapsed queued
/// user messages. All other queued user messages are omitted from the output.
/// Non-queued messages (and assistant messages in general) pass through
/// unchanged.
public enum TranscriptItems {

    /// Stable sentinel UUID for the queued-messages marker so SwiftUI `ForEach`
    /// maintains view identity across queue mutations (in particular when the
    /// head of the queue dequeues and the "first queued message" id would
    /// otherwise change). Mirrors `TranscriptProjector.thinkingPlaceholderId`.
    /// Must not collide with real message IDs.
    public static let queueMarkerId = UUID(uuidString: "00000000-0000-0000-0000-0000000055EE")!

    /// Builds the ordered list of transcript items to display.
    ///
    /// - Parameter messages: The source list of chat messages in display order.
    /// - Returns: A list where consecutive-or-scattered queued user messages
    ///   have been replaced with a single `queuedMarker` placed at the position
    ///   of the first collapsed message.
    public static func build(from messages: [ChatMessage]) -> [TranscriptItem] {
        let queuedCount = messages.reduce(into: 0) { count, message in
            if message.role == .user, case .queued = message.status {
                count += 1
            }
        }
        guard queuedCount > 0 else {
            return messages.map { .message($0) }
        }

        var result: [TranscriptItem] = []
        result.reserveCapacity(messages.count - queuedCount + 1)
        var markerInserted = false
        for message in messages {
            let isQueuedUser: Bool = {
                guard message.role == .user else { return false }
                if case .queued = message.status { return true }
                return false
            }()
            if isQueuedUser {
                if !markerInserted {
                    result.append(.queuedMarker(count: queuedCount))
                    markerInserted = true
                }
                // Otherwise: collapse into the already-inserted marker.
            } else {
                result.append(.message(message))
            }
        }
        return result
    }

    /// Resolves a raw message ID to the ID of the transcript item that
    /// actually renders it. Queued user messages are collapsed into the
    /// `queuedMarker`, so scrolling or flashing their original IDs is a
    /// no-op — callers that target IDs from the full `messages` array
    /// must route through this helper before handing the ID to
    /// `scrollTo(id:)` or the highlight binding.
    ///
    /// - Returns: The `queuedMarker` anchor ID when `messageId` belongs to
    ///   a collapsed queued user message; `messageId` otherwise. Returns
    ///   `nil` if the ID isn't present in `messages`.
    public static func displayId(for messageId: UUID, in messages: [ChatMessage]) -> UUID? {
        guard let target = messages.first(where: { $0.id == messageId }) else {
            return nil
        }
        let isQueuedUser: Bool = {
            guard target.role == .user else { return false }
            if case .queued = target.status { return true }
            return false
        }()
        guard isQueuedUser else { return messageId }
        return queueMarkerId
    }
}
