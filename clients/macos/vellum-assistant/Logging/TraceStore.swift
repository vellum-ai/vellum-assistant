import Foundation
import VellumAssistantShared

/// In-memory store for real-time execution trace events, keyed by session.
///
/// Events are grouped by `requestId` within each session, deduplicated by `eventId`,
/// and ordered by `sequence` (with `timestampMs` and insertion order as tiebreakers).
@MainActor
public final class TraceStore: ObservableObject {

    // MARK: - Types

    /// A single trace event with stable ordering metadata.
    public struct StoredEvent: Identifiable, Sendable {
        public let id: String // eventId
        public let sessionId: String
        public let requestId: String?
        public let timestampMs: Double
        public let sequence: Int
        public let kind: String
        public let status: String?
        public let summary: String
        public let attributes: [String: AnyCodable]?
        /// Monotonic insertion index for tiebreaking.
        let insertionIndex: Int
    }

    // MARK: - State

    /// All events per session, in stable order.
    @Published public private(set) var eventsBySession: [String: [StoredEvent]] = [:]

    /// The ID of the most recently ingested event per session. Unlike `eventsBySession[sid]?.count`,
    /// this always changes on ingestion even when the retention cap holds count constant.
    @Published public private(set) var latestEventIdBySession: [String: String] = [:]

    /// Set of seen eventIds per session for dedup.
    private var seenIds: [String: Set<String>] = [:]

    /// Monotonic counter for insertion ordering tiebreaks.
    private var nextInsertionIndex: Int = 0

    /// Maximum events retained per session.
    public static let retentionCap = 5000

    // MARK: - Ingestion

    /// Ingest a trace event message from the daemon.
    public func ingest(_ msg: TraceEventMessage) {
        let sid = msg.sessionId

        // Deduplicate by eventId.
        if seenIds[sid, default: []].contains(msg.eventId) { return }
        seenIds[sid, default: []].insert(msg.eventId)

        let event = StoredEvent(
            id: msg.eventId,
            sessionId: sid,
            requestId: msg.requestId,
            timestampMs: msg.timestampMs,
            sequence: msg.sequence,
            kind: msg.kind,
            status: msg.status,
            summary: msg.summary,
            attributes: msg.attributes,
            insertionIndex: nextInsertionIndex
        )
        nextInsertionIndex += 1

        var events = eventsBySession[sid, default: []]
        // Insert in sorted position (sequence → timestampMs → insertionIndex).
        let idx = events.insertionIndex(for: event)
        events.insert(event, at: idx)

        // Enforce retention cap — drop oldest (lowest sequence/insertion).
        if events.count > Self.retentionCap {
            let overflow = events.count - Self.retentionCap
            let removedIds = events.prefix(overflow).map(\.id)
            events.removeFirst(overflow)
            for rid in removedIds {
                seenIds[sid]?.remove(rid)
            }
        }

        eventsBySession[sid] = events
        latestEventIdBySession[sid] = event.id
    }

    // MARK: - Queries

    /// Events for a session grouped by requestId. Events with nil requestId go under an empty-string key.
    public func eventsByRequest(sessionId: String) -> [String: [StoredEvent]] {
        guard let events = eventsBySession[sessionId] else { return [:] }
        return Dictionary(grouping: events) { $0.requestId ?? "" }
    }

    // MARK: - Request Group Status

    /// Terminal status for a request group.
    public enum RequestGroupStatus: Sendable {
        case active
        case completed
        case cancelled
        case error
    }

    /// Determines the terminal status of a request group by inspecting its events.
    ///
    /// A request is considered terminal when it contains a `message_complete`,
    /// `generation_cancelled`, or `request_error` event (matching the daemon's
    /// `TraceEventKind` contract). If none of those are present but any event
    /// has `status == "error"`, the group is marked as error.
    public func requestGroupStatus(sessionId: String, requestId: String) -> RequestGroupStatus {
        let key = requestId.isEmpty ? "" : requestId
        let grouped = eventsByRequest(sessionId: sessionId)
        guard let events = grouped[key] else { return .active }

        for event in events {
            switch event.kind {
            case "generation_cancelled":
                return .cancelled
            case "request_error":
                return .error
            case "message_complete":
                return .completed
            default:
                break
            }
        }

        // Fall back to checking individual event status fields.
        if events.contains(where: { $0.status == "error" }) {
            return .error
        }

        return .active
    }

    // MARK: - Derived Metrics

    /// Number of unique requestIds in a session.
    public func requestCount(sessionId: String) -> Int {
        guard let events = eventsBySession[sessionId] else { return 0 }
        var ids = Set<String>()
        for e in events {
            if let rid = e.requestId {
                ids.insert(rid)
            }
        }
        return ids.count
    }

    /// Count of `llm_call_finished` events in a session.
    public func llmCallCount(sessionId: String) -> Int {
        guard let events = eventsBySession[sessionId] else { return 0 }
        return events.count(where: { $0.kind == "llm_call_finished" })
    }

    /// Total input tokens across all `llm_call_finished` events.
    public func totalInputTokens(sessionId: String) -> Int {
        sumAttribute(sessionId: sessionId, kind: "llm_call_finished", key: "inputTokens")
    }

    /// Total output tokens across all `llm_call_finished` events.
    public func totalOutputTokens(sessionId: String) -> Int {
        sumAttribute(sessionId: sessionId, kind: "llm_call_finished", key: "outputTokens")
    }

    /// Average latency (ms) of `llm_call_finished` events, or 0 if none.
    public func averageLlmLatencyMs(sessionId: String) -> Double {
        guard let events = eventsBySession[sessionId] else { return 0 }
        let latencies: [Double] = events.compactMap { e in
            guard e.kind == "llm_call_finished" else { return nil }
            return doubleAttribute(e, key: "latencyMs")
        }
        guard !latencies.isEmpty else { return 0 }
        return latencies.reduce(0, +) / Double(latencies.count)
    }

    /// Count of `tool_failed` events in a session.
    public func toolFailureCount(sessionId: String) -> Int {
        guard let events = eventsBySession[sessionId] else { return 0 }
        return events.count(where: { $0.kind == "tool_failed" })
    }

    // MARK: - Reset

    /// Remove all events for a given session.
    public func resetSession(sessionId: String) {
        eventsBySession.removeValue(forKey: sessionId)
        latestEventIdBySession.removeValue(forKey: sessionId)
        seenIds.removeValue(forKey: sessionId)
    }

    /// Remove all events for all sessions.
    public func resetAll() {
        eventsBySession.removeAll()
        latestEventIdBySession.removeAll()
        seenIds.removeAll()
        nextInsertionIndex = 0
    }

    // MARK: - Helpers

    private func sumAttribute(sessionId: String, kind: String, key: String) -> Int {
        guard let events = eventsBySession[sessionId] else { return 0 }
        return events.reduce(0) { total, e in
            guard e.kind == kind else { return total }
            return total + intAttribute(e, key: key)
        }
    }

    private func intAttribute(_ event: StoredEvent, key: String) -> Int {
        guard let attrs = event.attributes, let val = attrs[key] else { return 0 }
        if let i = val.value as? Int { return i }
        if let d = val.value as? Double { return Int(d) }
        return 0
    }

    private func doubleAttribute(_ event: StoredEvent, key: String) -> Double? {
        guard let attrs = event.attributes, let val = attrs[key] else { return nil }
        if let d = val.value as? Double { return d }
        if let i = val.value as? Int { return Double(i) }
        return nil
    }
}

// MARK: - Sorted Insertion

private extension Array where Element == TraceStore.StoredEvent {
    /// Returns the index at which `event` should be inserted to maintain stable order.
    func insertionIndex(for event: Element) -> Int {
        var lo = startIndex, hi = endIndex
        while lo < hi {
            let mid = lo + (hi - lo) / 2
            if self[mid].comesBefore(event) {
                lo = mid + 1
            } else {
                hi = mid
            }
        }
        return lo
    }
}

private extension TraceStore.StoredEvent {
    func comesBefore(_ other: TraceStore.StoredEvent) -> Bool {
        if sequence != other.sequence { return sequence < other.sequence }
        if timestampMs != other.timestampMs { return timestampMs < other.timestampMs }
        return insertionIndex < other.insertionIndex
    }
}
