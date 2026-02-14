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

    // MARK: - Session Switching Shows Correct Traces

    @Test @MainActor
    func sessionSwitchingShowsCorrectTraces() {
        let store = TraceStore()

        // Populate two sessions with distinct events.
        store.ingest(makeEvent(eventId: "s1-a", sessionId: "session-A", requestId: "rA", sequence: 1, kind: "request_started", summary: "Start A"))
        store.ingest(makeEvent(eventId: "s1-b", sessionId: "session-A", requestId: "rA", sequence: 2, kind: "llm_call_finished", summary: "LLM A"))

        store.ingest(makeEvent(eventId: "s2-a", sessionId: "session-B", requestId: "rB", sequence: 1, kind: "request_started", summary: "Start B"))
        store.ingest(makeEvent(eventId: "s2-b", sessionId: "session-B", requestId: "rB", sequence: 2, kind: "tool_started", summary: "Tool B"))
        store.ingest(makeEvent(eventId: "s2-c", sessionId: "session-B", requestId: "rB", sequence: 3, kind: "tool_failed", summary: "Fail B"))

        // "Switch" to session-A — only its events are visible.
        let eventsA = store.eventsBySession["session-A"] ?? []
        #expect(eventsA.count == 2)
        #expect(eventsA.allSatisfy { $0.sessionId == "session-A" })

        // "Switch" to session-B — only its events are visible.
        let eventsB = store.eventsBySession["session-B"] ?? []
        #expect(eventsB.count == 3)
        #expect(eventsB.allSatisfy { $0.sessionId == "session-B" })

        // Metrics are scoped correctly.
        #expect(store.llmCallCount(sessionId: "session-A") == 1)
        #expect(store.llmCallCount(sessionId: "session-B") == 0)
        #expect(store.toolFailureCount(sessionId: "session-A") == 0)
        #expect(store.toolFailureCount(sessionId: "session-B") == 1)
    }

    // MARK: - No Cross-Session Trace Contamination

    @Test @MainActor
    func noCrossSessionContamination() {
        let store = TraceStore()

        // Session 1 events.
        store.ingest(makeEvent(eventId: "e1", sessionId: "s1", requestId: "r1", sequence: 1, kind: "request_started"))
        store.ingest(makeEvent(eventId: "e2", sessionId: "s1", requestId: "r1", sequence: 2, kind: "llm_call_finished",
                               attributes: ["inputTokens": 100, "outputTokens": 50]))

        // Session 2 events.
        store.ingest(makeEvent(eventId: "e3", sessionId: "s2", requestId: "r2", sequence: 1, kind: "request_started"))
        store.ingest(makeEvent(eventId: "e4", sessionId: "s2", requestId: "r2", sequence: 2, kind: "tool_failed"))

        // Session 1 must not see session 2's events.
        let grouped1 = store.eventsByRequest(sessionId: "s1")
        #expect(grouped1.count == 1)
        #expect(grouped1["r1"]?.count == 2)
        #expect(grouped1["r2"] == nil)

        // Session 2 must not see session 1's events.
        let grouped2 = store.eventsByRequest(sessionId: "s2")
        #expect(grouped2.count == 1)
        #expect(grouped2["r2"]?.count == 2)
        #expect(grouped2["r1"] == nil)

        // Adding more events to one session does not affect the other.
        store.ingest(makeEvent(eventId: "e5", sessionId: "s1", requestId: "r1", sequence: 3, kind: "request_finished"))
        #expect(store.eventsBySession["s1"]?.count == 3)
        #expect(store.eventsBySession["s2"]?.count == 2)
    }

    // MARK: - Cancellation Terminal Event

    @Test @MainActor
    func cancellationTerminalEvent() {
        let store = TraceStore()

        store.ingest(makeEvent(eventId: "e1", requestId: "r1", sequence: 1, kind: "request_started"))
        store.ingest(makeEvent(eventId: "e2", requestId: "r1", sequence: 2, kind: "llm_call_started"))
        store.ingest(makeEvent(eventId: "e3", requestId: "r1", sequence: 3, kind: "request_cancelled", summary: "Cancelled by user"))

        let status = store.requestGroupStatus(sessionId: "s1", requestId: "r1")
        #expect(status == .cancelled)
    }

    // MARK: - Error Terminal Event

    @Test @MainActor
    func errorTerminalEvent() {
        let store = TraceStore()

        store.ingest(makeEvent(eventId: "e1", requestId: "r1", sequence: 1, kind: "request_started"))
        store.ingest(makeEvent(eventId: "e2", requestId: "r1", sequence: 2, kind: "llm_call_started"))
        store.ingest(makeEvent(eventId: "e3", requestId: "r1", sequence: 3, kind: "request_failed", status: "error", summary: "API error"))

        let status = store.requestGroupStatus(sessionId: "s1", requestId: "r1")
        #expect(status == .error)
    }

    // MARK: - Completed Terminal Event

    @Test @MainActor
    func completedTerminalEvent() {
        let store = TraceStore()

        store.ingest(makeEvent(eventId: "e1", requestId: "r1", sequence: 1, kind: "request_started"))
        store.ingest(makeEvent(eventId: "e2", requestId: "r1", sequence: 2, kind: "request_finished"))

        let status = store.requestGroupStatus(sessionId: "s1", requestId: "r1")
        #expect(status == .completed)
    }

    // MARK: - Active Request Group (no terminal event)

    @Test @MainActor
    func activeRequestGroup() {
        let store = TraceStore()

        store.ingest(makeEvent(eventId: "e1", requestId: "r1", sequence: 1, kind: "request_started"))
        store.ingest(makeEvent(eventId: "e2", requestId: "r1", sequence: 2, kind: "llm_call_started"))

        let status = store.requestGroupStatus(sessionId: "s1", requestId: "r1")
        #expect(status == .active)
    }

    // MARK: - Error Status Fallback

    @Test @MainActor
    func errorStatusFallback() {
        let store = TraceStore()

        // No terminal kind event, but an event with status "error".
        store.ingest(makeEvent(eventId: "e1", requestId: "r1", sequence: 1, kind: "request_started"))
        store.ingest(makeEvent(eventId: "e2", requestId: "r1", sequence: 2, kind: "tool_failed", status: "error", summary: "tool crashed"))

        let status = store.requestGroupStatus(sessionId: "s1", requestId: "r1")
        #expect(status == .error)
    }

    // MARK: - Unknown Request Group Returns Active

    @Test @MainActor
    func unknownRequestGroupReturnsActive() {
        let store = TraceStore()
        let status = store.requestGroupStatus(sessionId: "nonexistent", requestId: "r1")
        #expect(status == .active)
    }

    // MARK: - Daemon Reconnect Resets Trace State

    @Test @MainActor
    func daemonReconnectResetsTraceState() {
        let store = TraceStore()

        // Populate with events from two sessions.
        store.ingest(makeEvent(eventId: "e1", sessionId: "s1", sequence: 1))
        store.ingest(makeEvent(eventId: "e2", sessionId: "s2", sequence: 1))
        #expect(store.eventsBySession.count == 2)

        // Simulate daemon reconnect by calling resetAll().
        store.resetAll()

        #expect(store.eventsBySession.isEmpty)

        // New events can be ingested after reset, even with the same eventIds
        // (dedup state was also cleared).
        store.ingest(makeEvent(eventId: "e1", sessionId: "s1", sequence: 1, summary: "post-reset"))
        #expect(store.eventsBySession["s1"]?.count == 1)
        #expect(store.eventsBySession["s1"]?.first?.summary == "post-reset")
    }

    // MARK: - Historical Traces Retained Per Session

    @Test @MainActor
    func historicalTracesRetainedPerSession() {
        let store = TraceStore()

        // Build up events across multiple sessions.
        for i in 0..<10 {
            store.ingest(makeEvent(eventId: "s1-\(i)", sessionId: "s1", requestId: "r1", sequence: i))
            store.ingest(makeEvent(eventId: "s2-\(i)", sessionId: "s2", requestId: "r2", sequence: i))
            store.ingest(makeEvent(eventId: "s3-\(i)", sessionId: "s3", requestId: "r3", sequence: i))
        }

        // All three sessions' traces are retained simultaneously.
        #expect(store.eventsBySession.count == 3)
        #expect(store.eventsBySession["s1"]?.count == 10)
        #expect(store.eventsBySession["s2"]?.count == 10)
        #expect(store.eventsBySession["s3"]?.count == 10)

        // Resetting one session preserves the others.
        store.resetSession(sessionId: "s2")
        #expect(store.eventsBySession.count == 2)
        #expect(store.eventsBySession["s1"]?.count == 10)
        #expect(store.eventsBySession["s3"]?.count == 10)
    }
}
