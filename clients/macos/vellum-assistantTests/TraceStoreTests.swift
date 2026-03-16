import Foundation
import Testing
@testable import VellumAssistantLib
import VellumAssistantShared

// Helper to build a TraceEventMessage via JSON round-trip since it's Decodable-only.
private func makeEvent(
    eventId: String = UUID().uuidString,
    conversationId: String = "s1",
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
        "conversationId": conversationId,
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

        let events = store.eventsByConversation["s1"]!
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

        let events = store.eventsByConversation["s1"]!
        #expect(events.map(\.id) == ["a", "b", "c"])
    }

    @Test @MainActor
    func timestampTiebreaker() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "x", timestampMs: 200, sequence: 1))
        store.ingest(makeEvent(eventId: "y", timestampMs: 100, sequence: 1))

        let events = store.eventsByConversation["s1"]!
        #expect(events[0].id == "y")
        #expect(events[1].id == "x")
    }

    @Test @MainActor
    func insertionOrderTiebreaker() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "first", timestampMs: 100, sequence: 1))
        store.ingest(makeEvent(eventId: "second", timestampMs: 100, sequence: 1))

        let events = store.eventsByConversation["s1"]!
        #expect(events[0].id == "first")
        #expect(events[1].id == "second")
    }

    // MARK: - Deduplication

    @Test @MainActor
    func deduplicateByEventId() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "dup", sequence: 1, summary: "original"))
        store.ingest(makeEvent(eventId: "dup", sequence: 1, summary: "duplicate"))

        let events = store.eventsByConversation["s1"]!
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

        let grouped = store.eventsByRequest(conversationId: "s1")
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

        #expect(store.requestCount(conversationId: "s1") == 2)
    }

    @Test @MainActor
    func llmCallCount() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "a", sequence: 1, kind: "llm_call_finished"))
        store.ingest(makeEvent(eventId: "b", sequence: 2, kind: "llm_call_finished"))
        store.ingest(makeEvent(eventId: "c", sequence: 3, kind: "tool_started"))

        #expect(store.llmCallCount(conversationId: "s1") == 2)
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

        #expect(store.totalInputTokens(conversationId: "s1") == 300)
        #expect(store.totalOutputTokens(conversationId: "s1") == 125)
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

        #expect(store.averageLlmLatencyMs(conversationId: "s1") == 150.0)
    }

    @Test @MainActor
    func averageLlmLatencyExcludesMissingAttribute() {
        let store = TraceStore()
        store.ingest(makeEvent(
            eventId: "a", sequence: 1, kind: "llm_call_finished",
            attributes: ["latencyMs": 100.0]
        ))
        store.ingest(makeEvent(
            eventId: "b", sequence: 2, kind: "llm_call_finished",
            attributes: ["latencyMs": 200.0]
        ))
        // Event without latencyMs should be excluded, not counted as 0.
        store.ingest(makeEvent(
            eventId: "c", sequence: 3, kind: "llm_call_finished",
            attributes: ["inputTokens": 50]
        ))
        store.ingest(makeEvent(
            eventId: "d", sequence: 4, kind: "llm_call_finished"
        ))

        #expect(store.averageLlmLatencyMs(conversationId: "s1") == 150.0)
    }

    @Test @MainActor
    func averageLlmLatencyEmpty() {
        let store = TraceStore()
        #expect(store.averageLlmLatencyMs(conversationId: "s1") == 0)
    }

    @Test @MainActor
    func toolFailureCount() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "a", sequence: 1, kind: "tool_failed"))
        store.ingest(makeEvent(eventId: "b", sequence: 2, kind: "tool_finished"))
        store.ingest(makeEvent(eventId: "c", sequence: 3, kind: "tool_failed"))

        #expect(store.toolFailureCount(conversationId: "s1") == 2)
    }

    // MARK: - Retention Cap

    @Test @MainActor
    func retentionCapEnforcement() {
        let store = TraceStore()
        let cap = TraceStore.retentionCap

        for i in 0..<(cap + 100) {
            store.ingest(makeEvent(eventId: "e\(i)", sequence: i))
        }

        let events = store.eventsByConversation["s1"]!
        #expect(events.count == cap)
        // Oldest events (lowest sequence) should have been dropped.
        #expect(events.first?.id == "e100")
        #expect(events.last?.id == "e\(cap + 99)")
    }

    // MARK: - Reset APIs

    @Test @MainActor
    func resetConversation() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "a", conversationId: "s1", sequence: 1))
        store.ingest(makeEvent(eventId: "b", conversationId: "s2", sequence: 1))

        store.resetConversation(conversationId: "s1")

        #expect(store.eventsByConversation["s1"] == nil)
        #expect(store.eventsByConversation["s2"]?.count == 1)

        // Dedup state is cleared — same eventId can be re-ingested.
        store.ingest(makeEvent(eventId: "a", conversationId: "s1", sequence: 1))
        #expect(store.eventsByConversation["s1"]?.count == 1)
    }

    @Test @MainActor
    func resetAll() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "a", conversationId: "s1", sequence: 1))
        store.ingest(makeEvent(eventId: "b", conversationId: "s2", sequence: 1))

        store.resetAll()

        #expect(store.eventsByConversation.isEmpty)
    }

    // MARK: - Multi-Conversation Isolation

    @Test @MainActor
    func conversationsAreIsolated() {
        let store = TraceStore()
        store.ingest(makeEvent(eventId: "a", conversationId: "s1", sequence: 1, kind: "tool_failed"))
        store.ingest(makeEvent(
            eventId: "b", conversationId: "s2", sequence: 1, kind: "llm_call_finished",
            attributes: ["inputTokens": 50, "outputTokens": 25, "latencyMs": 100.0]
        ))

        #expect(store.toolFailureCount(conversationId: "s1") == 1)
        #expect(store.toolFailureCount(conversationId: "s2") == 0)
        #expect(store.llmCallCount(conversationId: "s1") == 0)
        #expect(store.llmCallCount(conversationId: "s2") == 1)
    }

    // MARK: - Conversation Switching Shows Correct Traces

    @Test @MainActor
    func conversationSwitchingShowsCorrectTraces() {
        let store = TraceStore()

        // Populate two conversations with distinct events.
        store.ingest(makeEvent(eventId: "s1-a", conversationId: "session-A", requestId: "rA", sequence: 1, kind: "request_received", summary: "Start A"))
        store.ingest(makeEvent(eventId: "s1-b", conversationId: "session-A", requestId: "rA", sequence: 2, kind: "llm_call_finished", summary: "LLM A"))

        store.ingest(makeEvent(eventId: "s2-a", conversationId: "session-B", requestId: "rB", sequence: 1, kind: "request_received", summary: "Start B"))
        store.ingest(makeEvent(eventId: "s2-b", conversationId: "session-B", requestId: "rB", sequence: 2, kind: "tool_started", summary: "Tool B"))
        store.ingest(makeEvent(eventId: "s2-c", conversationId: "session-B", requestId: "rB", sequence: 3, kind: "tool_failed", summary: "Fail B"))

        // "Switch" to conversation-A — only its events are visible.
        let eventsA = store.eventsByConversation["session-A"] ?? []
        #expect(eventsA.count == 2)
        #expect(eventsA.allSatisfy { $0.conversationId == "session-A" })

        // "Switch" to conversation-B — only its events are visible.
        let eventsB = store.eventsByConversation["session-B"] ?? []
        #expect(eventsB.count == 3)
        #expect(eventsB.allSatisfy { $0.conversationId == "session-B" })

        // Metrics are scoped correctly.
        #expect(store.llmCallCount(conversationId: "session-A") == 1)
        #expect(store.llmCallCount(conversationId: "session-B") == 0)
        #expect(store.toolFailureCount(conversationId: "session-A") == 0)
        #expect(store.toolFailureCount(conversationId: "session-B") == 1)
    }

    // MARK: - No Cross-Conversation Trace Contamination

    @Test @MainActor
    func noCrossConversationContamination() {
        let store = TraceStore()

        // Conversation 1 events.
        store.ingest(makeEvent(eventId: "e1", conversationId: "s1", requestId: "r1", sequence: 1, kind: "request_received"))
        store.ingest(makeEvent(eventId: "e2", conversationId: "s1", requestId: "r1", sequence: 2, kind: "llm_call_finished",
                               attributes: ["inputTokens": 100, "outputTokens": 50]))

        // Conversation 2 events.
        store.ingest(makeEvent(eventId: "e3", conversationId: "s2", requestId: "r2", sequence: 1, kind: "request_received"))
        store.ingest(makeEvent(eventId: "e4", conversationId: "s2", requestId: "r2", sequence: 2, kind: "tool_failed"))

        // Conversation 1 must not see conversation 2's events.
        let grouped1 = store.eventsByRequest(conversationId: "s1")
        #expect(grouped1.count == 1)
        #expect(grouped1["r1"]?.count == 2)
        #expect(grouped1["r2"] == nil)

        // Conversation 2 must not see conversation 1's events.
        let grouped2 = store.eventsByRequest(conversationId: "s2")
        #expect(grouped2.count == 1)
        #expect(grouped2["r2"]?.count == 2)
        #expect(grouped2["r1"] == nil)

        // Adding more events to one conversation does not affect the other.
        store.ingest(makeEvent(eventId: "e5", conversationId: "s1", requestId: "r1", sequence: 3, kind: "message_complete"))
        #expect(store.eventsByConversation["s1"]?.count == 3)
        #expect(store.eventsByConversation["s2"]?.count == 2)
    }

    // MARK: - Handoff Terminal Event

    @Test @MainActor
    func handoffTerminalEvent() {
        let store = TraceStore()

        store.ingest(makeEvent(eventId: "e1", requestId: "r1", sequence: 1, kind: "request_received"))
        store.ingest(makeEvent(eventId: "e2", requestId: "r1", sequence: 2, kind: "llm_call_started"))
        store.ingest(makeEvent(eventId: "e3", requestId: "r1", sequence: 3, kind: "generation_handoff", summary: "Handing off to next queued message"))

        let status = store.requestGroupStatus(conversationId: "s1", requestId: "r1")
        #expect(status == .handedOff)
    }

    // MARK: - Cancellation Terminal Event

    @Test @MainActor
    func cancellationTerminalEvent() {
        let store = TraceStore()

        store.ingest(makeEvent(eventId: "e1", requestId: "r1", sequence: 1, kind: "request_received"))
        store.ingest(makeEvent(eventId: "e2", requestId: "r1", sequence: 2, kind: "llm_call_started"))
        store.ingest(makeEvent(eventId: "e3", requestId: "r1", sequence: 3, kind: "generation_cancelled", summary: "Cancelled by user"))

        let status = store.requestGroupStatus(conversationId: "s1", requestId: "r1")
        #expect(status == .cancelled)
    }

    // MARK: - Error Terminal Event

    @Test @MainActor
    func errorTerminalEvent() {
        let store = TraceStore()

        store.ingest(makeEvent(eventId: "e1", requestId: "r1", sequence: 1, kind: "request_received"))
        store.ingest(makeEvent(eventId: "e2", requestId: "r1", sequence: 2, kind: "llm_call_started"))
        store.ingest(makeEvent(eventId: "e3", requestId: "r1", sequence: 3, kind: "request_error", status: "error", summary: "API error"))

        let status = store.requestGroupStatus(conversationId: "s1", requestId: "r1")
        #expect(status == .error)
    }

    // MARK: - Completed Terminal Event

    @Test @MainActor
    func completedTerminalEvent() {
        let store = TraceStore()

        store.ingest(makeEvent(eventId: "e1", requestId: "r1", sequence: 1, kind: "request_received"))
        store.ingest(makeEvent(eventId: "e2", requestId: "r1", sequence: 2, kind: "message_complete"))

        let status = store.requestGroupStatus(conversationId: "s1", requestId: "r1")
        #expect(status == .completed)
    }

    // MARK: - Active Request Group (no terminal event)

    @Test @MainActor
    func activeRequestGroup() {
        let store = TraceStore()

        store.ingest(makeEvent(eventId: "e1", requestId: "r1", sequence: 1, kind: "request_received"))
        store.ingest(makeEvent(eventId: "e2", requestId: "r1", sequence: 2, kind: "llm_call_started"))

        let status = store.requestGroupStatus(conversationId: "s1", requestId: "r1")
        #expect(status == .active)
    }

    // MARK: - Error Status Fallback

    @Test @MainActor
    func errorStatusFallback() {
        let store = TraceStore()

        // No terminal kind event, but an event with status "error".
        store.ingest(makeEvent(eventId: "e1", requestId: "r1", sequence: 1, kind: "request_received"))
        store.ingest(makeEvent(eventId: "e2", requestId: "r1", sequence: 2, kind: "tool_failed", status: "error", summary: "tool crashed"))

        let status = store.requestGroupStatus(conversationId: "s1", requestId: "r1")
        #expect(status == .error)
    }

    // MARK: - Unknown Request Group Returns Active

    @Test @MainActor
    func unknownRequestGroupReturnsActive() {
        let store = TraceStore()
        let status = store.requestGroupStatus(conversationId: "nonexistent", requestId: "r1")
        #expect(status == .active)
    }

    // MARK: - Daemon Reconnect Resets Trace State

    @Test @MainActor
    func daemonReconnectResetsTraceState() {
        let store = TraceStore()

        // Populate with events from two conversations.
        store.ingest(makeEvent(eventId: "e1", conversationId: "s1", sequence: 1))
        store.ingest(makeEvent(eventId: "e2", conversationId: "s2", sequence: 1))
        #expect(store.eventsByConversation.count == 2)

        // Simulate daemon reconnect by calling resetAll().
        store.resetAll()

        #expect(store.eventsByConversation.isEmpty)

        // New events can be ingested after reset, even with the same eventIds
        // (dedup state was also cleared).
        store.ingest(makeEvent(eventId: "e1", conversationId: "s1", sequence: 1, summary: "post-reset"))
        #expect(store.eventsByConversation["s1"]?.count == 1)
        #expect(store.eventsByConversation["s1"]?.first?.summary == "post-reset")
    }

    // MARK: - Historical Traces Retained Per Conversation

    @Test @MainActor
    func historicalTracesRetainedPerConversation() {
        let store = TraceStore()

        // Build up events across multiple conversations.
        for i in 0..<10 {
            store.ingest(makeEvent(eventId: "s1-\(i)", conversationId: "s1", requestId: "r1", sequence: i))
            store.ingest(makeEvent(eventId: "s2-\(i)", conversationId: "s2", requestId: "r2", sequence: i))
            store.ingest(makeEvent(eventId: "s3-\(i)", conversationId: "s3", requestId: "r3", sequence: i))
        }

        // All three conversations' traces are retained simultaneously.
        #expect(store.eventsByConversation.count == 3)
        #expect(store.eventsByConversation["s1"]?.count == 10)
        #expect(store.eventsByConversation["s2"]?.count == 10)
        #expect(store.eventsByConversation["s3"]?.count == 10)

        // Resetting one conversation preserves the others.
        store.resetConversation(conversationId: "s2")
        #expect(store.eventsByConversation.count == 2)
        #expect(store.eventsByConversation["s1"]?.count == 10)
        #expect(store.eventsByConversation["s3"]?.count == 10)
    }
}
