import Foundation
import Testing
@testable import VellumAssistantLib
import VellumAssistantShared

// Helper to build a TraceEventMessage via JSON round-trip since it's Decodable-only.
private func makeEvent(
    eventId: String = UUID().uuidString,
    sessionId: String = "s1",
    requestId: String? = "r1",
    timestampMs: Double = 1000,
    sequence: Int = 0,
    kind: String = "generic",
    status: String? = nil,
    summary: String = "test",
    attributes: [String: Any]? = nil
) -> TraceEventMessage {
    var dict: [String: Any] = [
        "type": "trace_event",
        "eventId": eventId,
        "sessionId": sessionId,
        "timestampMs": timestampMs,
        "sequence": sequence,
        "kind": kind,
        "summary": summary
    ]
    if let requestId { dict["requestId"] = requestId }
    if let status { dict["status"] = status }
    if let attributes { dict["attributes"] = attributes }

    let data = try! JSONSerialization.data(withJSONObject: dict)
    return try! JSONDecoder().decode(TraceEventMessage.self, from: data)
}

@Suite("TraceStore")
struct TraceStoreTests {

    // MARK: - Basic Ingestion & Ordering

    @Test @MainActor
    func basicIngestionAndOrdering() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "a", sequence: 1, summary: "first"))
        store.ingest(makeEvent(eventId: "b", sequence: 2, summary: "second"))
        store.ingest(makeEvent(eventId: "c", sequence: 3, summary: "third"))

        let events = store.eventsBySession["s1"]!
        #expect(events.count == 3)
        #expect(events[0].id == "a")
        #expect(events[1].id == "b")
        #expect(events[2].id == "c")
    }

    // MARK: - Out-of-Order Ingestion

    @Test @MainActor
    func outOfOrderIngestion() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "c", sequence: 3))
        store.ingest(makeEvent(eventId: "a", sequence: 1))
        store.ingest(makeEvent(eventId: "b", sequence: 2))

        let events = store.eventsBySession["s1"]!
        #expect(events.map(\.id) == ["a", "b", "c"])
    }

    @Test @MainActor
    func timestampTiebreaker() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "x", timestampMs: 200, sequence: 1))
        store.ingest(makeEvent(eventId: "y", timestampMs: 100, sequence: 1))

        let events = store.eventsBySession["s1"]!
        #expect(events[0].id == "y")
        #expect(events[1].id == "x")
    }

    @Test @MainActor
    func insertionOrderTiebreaker() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "first", timestampMs: 100, sequence: 1))
        store.ingest(makeEvent(eventId: "second", timestampMs: 100, sequence: 1))

        let events = store.eventsBySession["s1"]!
        #expect(events[0].id == "first")
        #expect(events[1].id == "second")
    }

    // MARK: - Deduplication

    @Test @MainActor
    func deduplicateByEventId() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "dup", sequence: 1, summary: "original"))
        store.ingest(makeEvent(eventId: "dup", sequence: 1, summary: "duplicate"))

        let events = store.eventsBySession["s1"]!
        #expect(events.count == 1)
        #expect(events[0].summary == "original")
    }

    // MARK: - Request Grouping

    @Test @MainActor
    func eventsByRequestGrouping() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "a", requestId: "r1", sequence: 1))
        store.ingest(makeEvent(eventId: "b", requestId: "r2", sequence: 2))
        store.ingest(makeEvent(eventId: "c", requestId: nil, sequence: 3))
        store.ingest(makeEvent(eventId: "d", requestId: "r1", sequence: 4))

        let grouped = store.eventsByRequest(sessionId: "s1")
        #expect(grouped["r1"]?.count == 2)
        #expect(grouped["r2"]?.count == 1)
        #expect(grouped[""]?.count == 1)
    }

    // MARK: - Derived Metrics

    @Test @MainActor
    func requestCount() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "a", requestId: "r1", sequence: 1))
        store.ingest(makeEvent(eventId: "b", requestId: "r2", sequence: 2))
        store.ingest(makeEvent(eventId: "c", requestId: "r1", sequence: 3))
        store.ingest(makeEvent(eventId: "d", requestId: nil, sequence: 4))

        #expect(store.requestCount(sessionId: "s1") == 2)
    }

    @Test @MainActor
    func llmCallCount() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "a", sequence: 1, kind: "llm_call_finished"))
        store.ingest(makeEvent(eventId: "b", sequence: 2, kind: "llm_call_finished"))
        store.ingest(makeEvent(eventId: "c", sequence: 3, kind: "tool_started"))

        #expect(store.llmCallCount(sessionId: "s1") == 2)
    }

    @Test @MainActor
    func tokenCounts() {
        let store = TraceStore()
        store.ingest(makeEvent(
            eventId: "a", sequence: 1, kind: "llm_call_finished",
            attributes: ["inputTokens": 100, "outputTokens": 50]
        ))
        store.ingest(makeEvent(
            eventId: "b", sequence: 2, kind: "llm_call_finished",
            attributes: ["inputTokens": 200, "outputTokens": 75]
        ))

        #expect(store.totalInputTokens(sessionId: "s1") == 300)
        #expect(store.totalOutputTokens(sessionId: "s1") == 125)
    }

    @Test @MainActor
    func averageLlmLatency() {
        let store = TraceStore()
        store.ingest(makeEvent(
            eventId: "a", sequence: 1, kind: "llm_call_finished",
            attributes: ["latencyMs": 100.0]
        ))
        store.ingest(makeEvent(
            eventId: "b", sequence: 2, kind: "llm_call_finished",
            attributes: ["latencyMs": 200.0]
        ))

        #expect(store.averageLlmLatencyMs(sessionId: "s1") == 150.0)
    }

    @Test @MainActor
    func averageLlmLatencyEmpty() {
        let store = TraceStore()
        #expect(store.averageLlmLatencyMs(sessionId: "s1") == 0)
    }

    @Test @MainActor
    func toolFailureCount() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "a", sequence: 1, kind: "tool_failed"))
        store.ingest(makeEvent(eventId: "b", sequence: 2, kind: "tool_completed"))
        store.ingest(makeEvent(eventId: "c", sequence: 3, kind: "tool_failed"))

        #expect(store.toolFailureCount(sessionId: "s1") == 2)
    }

    // MARK: - Retention Cap

    @Test @MainActor
    func retentionCapEnforcement() {
        let store = TraceStore()
        let cap = TraceStore.retentionCap

        for i in 0..<(cap + 100) {
            store.ingest(makeEvent(eventId: "e\(i)", sequence: i))
        }

        let events = store.eventsBySession["s1"]!
        #expect(events.count == cap)
        // Oldest events (lowest sequence) should have been dropped.
        #expect(events.first?.id == "e100")
        #expect(events.last?.id == "e\(cap + 99)")
    }

    // MARK: - Reset APIs

    @Test @MainActor
    func resetSession() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "a", sessionId: "s1", sequence: 1))
        store.ingest(makeEvent(eventId: "b", sessionId: "s2", sequence: 1))

        store.resetSession(sessionId: "s1")

        #expect(store.eventsBySession["s1"] == nil)
        #expect(store.eventsBySession["s2"]?.count == 1)

        // Dedup state is cleared — same eventId can be re-ingested.
        store.ingest(makeEvent(eventId: "a", sessionId: "s1", sequence: 1))
        #expect(store.eventsBySession["s1"]?.count == 1)
    }

    @Test @MainActor
    func resetAll() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "a", sessionId: "s1", sequence: 1))
        store.ingest(makeEvent(eventId: "b", sessionId: "s2", sequence: 1))

        store.resetAll()

        #expect(store.eventsBySession.isEmpty)
    }

    // MARK: - Multi-Session Isolation

    @Test @MainActor
    func sessionsAreIsolated() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "a", sessionId: "s1", sequence: 1, kind: "tool_failed"))
        store.ingest(makeEvent(
            eventId: "b", sessionId: "s2", sequence: 1, kind: "llm_call_finished",
            attributes: ["inputTokens": 50, "outputTokens": 25, "latencyMs": 100.0]
        ))

        #expect(store.toolFailureCount(sessionId: "s1") == 1)
        #expect(store.toolFailureCount(sessionId: "s2") == 0)
        #expect(store.llmCallCount(sessionId: "s1") == 0)
        #expect(store.llmCallCount(sessionId: "s2") == 1)
    }
}
