import Foundation

/// In-memory store for real-time execution trace events, keyed by session.
///
/// Events are grouped by `requestId` within each session, deduplicated by `eventId`,
/// and ordered by `sequence` (with `timestampMs` and insertion order as tiebreakers).
@MainActor
public final class TraceStore: ObservableObject {

    public init() {}

    // MARK: - Types

    /// A single trace event with stable ordering metadata.
    public struct StoredEvent: Identifiable, Sendable {
        public let id: String // eventId
        public let conversationId: String
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

    // MARK: - Observation Gating

    /// When false, trace data still accumulates but `objectWillChange` is not
    /// fired — avoiding SwiftUI churn while the DebugPanel is hidden.
    /// Setting this to `true` immediately flushes a single publish so the
    /// panel picks up any data that arrived while it was off-screen.
    public var isObserved: Bool = false {
        didSet {
            if isObserved, !oldValue {
                objectWillChange.send()
            }
        }
    }

    // MARK: - State

    /// All events per session, in stable order.
    /// Not @Published — updates are coalesced via `schedulePublish()` to avoid
    /// firing objectWillChange on every individual trace event during bursts.
    public private(set) var eventsByConversation: [String: [StoredEvent]] = [:]

    /// The ID of the most recently ingested event per session. Unlike `eventsByConversation[sid]?.count`,
    /// this always changes on ingestion even when the retention cap holds count constant.
    public private(set) var latestEventIdBySession: [String: String] = [:]

    /// Set of seen eventIds per session for dedup.
    private var seenIds: [String: Set<String>] = [:]

    /// Monotonic counter for insertion ordering tiebreaks.
    private var nextInsertionIndex: Int = 0

    /// Coalesces rapid objectWillChange notifications into a single publish
    /// per 100ms window so SwiftUI doesn't re-evaluate on every trace event.
    private var publishTask: Task<Void, Never>?

    private func schedulePublish() {
        guard isObserved else { return }
        guard publishTask == nil else { return }
        publishTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 100_000_000)
            self?.objectWillChange.send()
            self?.publishTask = nil
        }
    }

    /// Maximum events retained per session.
    public static let retentionCap = 5000

    // MARK: - Ingestion

    /// Ingest a trace event message from the daemon.
    public func ingest(_ msg: TraceEventMessage) {
        let sid = msg.conversationId

        // Deduplicate by eventId.
        if seenIds[sid, default: []].contains(msg.eventId) { return }
        seenIds[sid, default: []].insert(msg.eventId)

        let event = StoredEvent(
            id: msg.eventId,
            conversationId: sid,
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

        var events = eventsByConversation[sid, default: []]
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

        eventsByConversation[sid] = events
        latestEventIdBySession[sid] = event.id
        generationBySession[sid, default: 0] += 1
        schedulePublish()
    }

    // MARK: - Queries

    /// Events for a session grouped by requestId. Events with nil requestId go under an empty-string key.
    public func eventsByRequest(conversationId: String) -> [String: [StoredEvent]] {
        guard let events = eventsByConversation[conversationId] else { return [:] }
        return Dictionary(grouping: events) { $0.requestId ?? "" }
    }

    // MARK: - Request Group Status

    /// Terminal status for a request group.
    public enum RequestGroupStatus: Sendable {
        case active
        case completed
        case cancelled
        case handedOff
        case error
    }

    /// Determines the terminal status of a request group by inspecting its events.
    ///
    /// A request is considered terminal when it contains a `message_complete`,
    /// `generation_cancelled`, `generation_handoff`, or `request_error` event
    /// (matching the daemon's `TraceEventKind` contract). If none of those are
    /// present but any event has `status == "error"`, the group is marked as error.
    public func requestGroupStatus(conversationId: String, requestId: String) -> RequestGroupStatus {
        let key = requestId.isEmpty ? "" : requestId
        let grouped = eventsByRequest(conversationId: conversationId)
        guard let events = grouped[key] else { return .active }

        for event in events {
            switch event.kind {
            case "generation_cancelled":
                return .cancelled
            case "generation_handoff":
                return .handedOff
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

    // MARK: - Derived Metrics (Cached)

    /// Snapshot of aggregate metrics for a session, recomputed only when the
    /// generation counter advances (i.e. new events were ingested).
    public struct ConversationMetrics {
        public let requestCount: Int
        public let llmCallCount: Int
        public let totalInputTokens: Int
        public let totalOutputTokens: Int
        public let averageLlmLatencyMs: Double
        public let toolFailureCount: Int

        static let empty = ConversationMetrics(
            requestCount: 0, llmCallCount: 0,
            totalInputTokens: 0, totalOutputTokens: 0,
            averageLlmLatencyMs: 0, toolFailureCount: 0
        )
    }

    /// Generation counter per session, incremented on each ingestion.
    private var generationBySession: [String: Int] = [:]

    /// Cached metrics per session, keyed by the generation at which they were computed.
    private var metricsCache: [String: (generation: Int, metrics: ConversationMetrics)] = [:]

    /// Returns cached aggregate metrics for a session, recomputing only when
    /// the generation counter has advanced since the last call.
    public func metrics(conversationId: String) -> ConversationMetrics {
        let currentGen = generationBySession[conversationId] ?? 0
        if let cached = metricsCache[conversationId], cached.generation == currentGen {
            return cached.metrics
        }
        let computed = computeMetrics(conversationId: conversationId)
        metricsCache[conversationId] = (generation: currentGen, metrics: computed)
        return computed
    }

    private func computeMetrics(conversationId: String) -> ConversationMetrics {
        guard let events = eventsByConversation[conversationId] else { return .empty }

        var requestIds = Set<String>()
        var llmCalls = 0
        var inputTokens = 0
        var outputTokens = 0
        var latencySum = 0.0
        var latencyCount = 0
        var toolFailures = 0

        for event in events {
            if let rid = event.requestId { requestIds.insert(rid) }
            switch event.kind {
            case "llm_call_finished":
                llmCalls += 1
                inputTokens += intAttribute(event, key: "inputTokens")
                outputTokens += intAttribute(event, key: "outputTokens")
                if let lat = doubleAttribute(event, key: "latencyMs") {
                    latencySum += lat
                    latencyCount += 1
                }
            case "tool_failed":
                toolFailures += 1
            default:
                break
            }
        }

        return ConversationMetrics(
            requestCount: requestIds.count,
            llmCallCount: llmCalls,
            totalInputTokens: inputTokens,
            totalOutputTokens: outputTokens,
            averageLlmLatencyMs: latencyCount > 0 ? latencySum / Double(latencyCount) : 0,
            toolFailureCount: toolFailures
        )
    }

    /// Number of unique requestIds in a session.
    public func requestCount(conversationId: String) -> Int {
        metrics(conversationId: conversationId).requestCount
    }

    /// Count of `llm_call_finished` events in a session.
    public func llmCallCount(conversationId: String) -> Int {
        metrics(conversationId: conversationId).llmCallCount
    }

    /// Total input tokens across all `llm_call_finished` events.
    public func totalInputTokens(conversationId: String) -> Int {
        metrics(conversationId: conversationId).totalInputTokens
    }

    /// Total output tokens across all `llm_call_finished` events.
    public func totalOutputTokens(conversationId: String) -> Int {
        metrics(conversationId: conversationId).totalOutputTokens
    }

    /// Average latency (ms) of `llm_call_finished` events, or 0 if none.
    public func averageLlmLatencyMs(conversationId: String) -> Double {
        metrics(conversationId: conversationId).averageLlmLatencyMs
    }

    /// Count of `tool_failed` events in a session.
    public func toolFailureCount(conversationId: String) -> Int {
        metrics(conversationId: conversationId).toolFailureCount
    }

    // MARK: - Session Selection

    /// Returns the session ID whose last event has the highest `timestampMs`,
    /// i.e. the most recently active session. Returns `nil` if no events exist.
    ///
    /// Used by developer tooling to auto-select a relevant session when no
    /// explicit selection context is available (e.g. when opening the debug panel
    /// from the Settings screen rather than from an active chat thread).
    public var mostRecentSessionId: String? {
        eventsByConversation
            .compactMapValues { $0.last?.timestampMs }
            .max(by: { $0.value < $1.value })
            .map(\.key)
    }

    // MARK: - Reset

    /// Remove all events for a given session.
    public func resetConversation(conversationId: String) {
        eventsByConversation.removeValue(forKey: conversationId)
        latestEventIdBySession.removeValue(forKey: conversationId)
        seenIds.removeValue(forKey: conversationId)
        generationBySession.removeValue(forKey: conversationId)
        metricsCache.removeValue(forKey: conversationId)
        schedulePublish()
    }

    /// Remove all events for all sessions.
    public func resetAll() {
        eventsByConversation.removeAll()
        latestEventIdBySession.removeAll()
        seenIds.removeAll()
        generationBySession.removeAll()
        metricsCache.removeAll()
        nextInsertionIndex = 0
        schedulePublish()
    }

    // MARK: - Helpers

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
