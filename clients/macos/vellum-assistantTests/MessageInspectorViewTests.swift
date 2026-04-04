import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class MessageInspectorViewTests: XCTestCase {
    func testDefaultsSelectionToMostRecentCallAfterLoad() {
        var state = MessageInspectorViewState()

        let requestToken = state.beginLoading(resetSelection: true)
        state.finishLoading(with: .loaded(makeResponse(logs: [
            makeLog(id: "older", createdAt: 1_000),
            makeLog(id: "newer", createdAt: 2_000)
        ])), requestToken: requestToken)

        XCTAssertEqual(state.loadState, .loaded)
        XCTAssertEqual(state.logs.map(\.id), ["newer", "older"])
        XCTAssertEqual(state.selectedLogID, "newer")
    }

    func testLoadStateSwitchesBetweenLoadingEmptyAndFailed() {
        var state = MessageInspectorViewState()

        let emptyRequestToken = state.beginLoading(resetSelection: true)
        XCTAssertEqual(state.loadState, .loading)

        state.finishLoading(with: .empty, requestToken: emptyRequestToken)
        XCTAssertEqual(state.loadState, .empty)
        XCTAssertNil(state.selectedLogID)

        let failedRequestToken = state.beginLoading(resetSelection: true)
        state.finishLoading(with: .failed, requestToken: failedRequestToken)
        XCTAssertEqual(state.loadState, .failed)
        XCTAssertNil(state.selectedLogID)
    }

    func testSwitchingDetailTabsPreservesSelectedCall() {
        var state = MessageInspectorViewState()
        let newer = makeLog(id: "newer", createdAt: 2_000)
        let older = makeLog(id: "older", createdAt: 1_000)

        let requestToken = state.beginLoading(resetSelection: true)
        state.finishLoading(with: .loaded(makeResponse(logs: [older, newer])), requestToken: requestToken)
        state.selectLog(id: "older")

        state.selectDetailTab(.prompt)
        state.selectDetailTab(.raw)

        XCTAssertEqual(state.selectedLogID, "older")
        XCTAssertEqual(state.selectedLog?.id, "older")
        XCTAssertEqual(state.selectedDetailTab, .raw)
    }

    func testMemoryRecallIsThreadedThroughViewState() {
        var state = MessageInspectorViewState()

        let requestToken = state.beginLoading(resetSelection: true)
        let recall = MemoryRecallData(
            enabled: true,
            degraded: false,
            provider: "anthropic",
            model: nil,
            degradation: nil,
            semanticHits: 3,
            mergedCount: 2,
            selectedCount: 1,
            tier1Count: 1,
            tier2Count: 0,
            hybridSearchLatencyMs: 15,
            sparseVectorUsed: false,
            injectedTokens: 200,
            latencyMs: 42,
            reason: nil,
            topCandidates: [],
            injectedText: nil,
            queryContext: nil
        )
        state.finishLoading(with: .loaded(makeResponse(logs: [
            makeLog(id: "a", createdAt: 1_000)
        ], memoryRecall: recall)), requestToken: requestToken)

        XCTAssertEqual(state.memoryRecall?.enabled, true)
        XCTAssertEqual(state.memoryRecall?.latencyMs, 42)
        XCTAssertEqual(state.memoryRecall?.semanticHits, 3)
    }

    func testMemoryRecallClearedOnEmpty() {
        var state = MessageInspectorViewState()

        let loadToken = state.beginLoading(resetSelection: true)
        let recall = MemoryRecallData(
            enabled: true,
            degraded: false,
            provider: nil,
            model: nil,
            degradation: nil,
            semanticHits: 0,
            mergedCount: 0,
            selectedCount: 0,
            tier1Count: 0,
            tier2Count: 0,
            hybridSearchLatencyMs: 5,
            sparseVectorUsed: false,
            injectedTokens: 0,
            latencyMs: 5,
            reason: nil,
            topCandidates: [],
            injectedText: nil,
            queryContext: nil
        )
        state.finishLoading(with: .loaded(makeResponse(logs: [
            makeLog(id: "a", createdAt: 1_000)
        ], memoryRecall: recall)), requestToken: loadToken)
        XCTAssertNotNil(state.memoryRecall)

        let emptyToken = state.beginLoading(resetSelection: true)
        state.finishLoading(with: .empty, requestToken: emptyToken)
        XCTAssertNil(state.memoryRecall)
    }

    func testMemoryTabCaseExists() {
        let tab = MessageInspectorDetailTab.memory
        XCTAssertEqual(tab.label, "Memory")
    }

    private func makeResponse(logs: [LLMRequestLogEntry], memoryRecall: MemoryRecallData? = nil) -> LLMContextResponse {
        LLMContextResponse(messageId: "message-1", logs: logs, memoryRecall: memoryRecall)
    }

    private func makeLog(
        id: String,
        createdAt: Int,
        title: String? = nil
    ) -> LLMRequestLogEntry {
        LLMRequestLogEntry(
            id: id,
            requestPayload: AnyCodable(["role": "user", "id": id]),
            responsePayload: AnyCodable(["role": "assistant", "id": id]),
            createdAt: createdAt,
            summary: LLMCallSummary(title: title),
            requestSections: nil,
            responseSections: nil
        )
    }
}
