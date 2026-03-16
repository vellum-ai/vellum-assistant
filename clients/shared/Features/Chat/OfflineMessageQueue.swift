import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "OfflineMessageQueue")

// MARK: - Queued Message

/// A single message buffered while the daemon was unreachable.
struct OfflineQueuedMessage: Codable, Identifiable {
    let id: UUID
    let conversationId: String?
    let text: String
    /// The text stored in the ChatMessage for UI matching. In voice mode, `text`
    /// carries the voice instruction prefix while the ChatMessage stores raw user
    /// input — this field preserves that raw text so flush can find the right bubble.
    let displayText: String?
    let attachments: [OfflineQueuedAttachment]
    /// Whether this message was originally sent as automated (e.g. wake-up greeting).
    /// Preserved so that resending after reconnect doesn't trigger memory extraction.
    let automated: Bool
    let enqueuedAt: Date

    init(conversationId: String?, text: String, displayText: String? = nil, attachments: [UserMessageAttachment]?, automated: Bool = false) {
        self.id = UUID()
        self.conversationId = conversationId
        self.text = text
        self.displayText = displayText
        self.automated = automated
        self.enqueuedAt = Date()
        self.attachments = (attachments ?? []).map {
            OfflineQueuedAttachment(filename: $0.filename, mimeType: $0.mimeType, data: $0.data, extractedText: $0.extractedText)
        }
    }

    // Legacy coding key for pre-rename persisted messages.
    private enum LegacyCodingKeys: String, CodingKey {
        case sessionId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        // Fall back to the legacy "sessionId" key for messages queued before the rename.
        if let cid = try container.decodeIfPresent(String.self, forKey: .conversationId) {
            conversationId = cid
        } else {
            let legacy = try decoder.container(keyedBy: LegacyCodingKeys.self)
            conversationId = try legacy.decodeIfPresent(String.self, forKey: .sessionId)
        }
        text = try container.decode(String.self, forKey: .text)
        displayText = try container.decodeIfPresent(String.self, forKey: .displayText)
        attachments = try container.decode([OfflineQueuedAttachment].self, forKey: .attachments)
        automated = try container.decodeIfPresent(Bool.self, forKey: .automated) ?? false
        enqueuedAt = try container.decode(Date.self, forKey: .enqueuedAt)
    }

    /// Reconstruct the attachment list for dispatch.
    var messageAttachments: [UserMessageAttachment]? {
        guard !attachments.isEmpty else { return nil }
        return attachments.map {
            UserMessageAttachment(filename: $0.filename, mimeType: $0.mimeType, data: $0.data, extractedText: $0.extractedText)
        }
    }
}

struct OfflineQueuedAttachment: Codable {
    let filename: String
    let mimeType: String
    /// Base64-encoded attachment data, matching the `UserMessageAttachment.data` string format.
    let data: String
    let extractedText: String?
}

// MARK: - Offline Message Queue

/// Persistent FIFO queue that buffers outgoing messages when the daemon is unreachable.
///
/// Messages are stored in UserDefaults so they survive app restarts. When the daemon
/// reconnects, the caller is responsible for flushing via `dequeueAll()` and sending
/// the messages in order.
///
/// Thread-safety: all mutations must occur on the main actor, consistent with ChatViewModel.
@MainActor
final class OfflineMessageQueue {

    static let shared = OfflineMessageQueue()

    private static let userDefaultsKey = "offline_message_queue_v1"

    private var queue: [OfflineQueuedMessage] = []

    var isEmpty: Bool { queue.isEmpty }
    var count: Int { queue.count }
    /// Read-only snapshot of all queued messages in FIFO order.
    var allMessages: [OfflineQueuedMessage] { queue }

    private init() {
        queue = Self.load()
        log.info("OfflineMessageQueue: loaded \(self.queue.count) queued message(s)")
    }

    // MARK: - Enqueue

    /// Append a message to the end of the offline queue and persist it.
    func enqueue(conversationId: String?, text: String, displayText: String? = nil, attachments: [UserMessageAttachment]?, automated: Bool = false) {
        let message = OfflineQueuedMessage(conversationId: conversationId, text: text, displayText: displayText, attachments: attachments, automated: automated)
        queue.append(message)
        save()
        log.info("OfflineMessageQueue: enqueued message (queue depth: \(self.queue.count))")
    }

    // MARK: - Dequeue

    /// Remove and return all queued messages in FIFO order, then clear persistence.
    func dequeueAll() -> [OfflineQueuedMessage] {
        let all = queue
        queue.removeAll()
        save()
        log.info("OfflineMessageQueue: dequeued \(all.count) message(s) for flush")
        return all
    }

    /// Remove the message with the given ID (e.g. after a successful send).
    func remove(id: UUID) {
        queue.removeAll { $0.id == id }
        save()
    }

    // MARK: - Persistence

    private func save() {
        guard let data = try? JSONEncoder().encode(queue) else { return }
        UserDefaults.standard.set(data, forKey: Self.userDefaultsKey)
    }

    private static func load() -> [OfflineQueuedMessage] {
        guard let data = UserDefaults.standard.data(forKey: userDefaultsKey),
              let messages = try? JSONDecoder().decode([OfflineQueuedMessage].self, from: data) else {
            return []
        }
        return messages
    }

    /// Drop all persisted messages. Intended for testing or manual reset.
    func clear() {
        queue.removeAll()
        UserDefaults.standard.removeObject(forKey: Self.userDefaultsKey)
    }
}
