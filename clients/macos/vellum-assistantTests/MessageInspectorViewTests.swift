import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class MessageInspectorViewTests: XCTestCase {
    func testDefaultsSelectionToMostRecentCallAfterLoad() {
        var state = MessageInspectorViewState()

        state.beginLoading(resetSelection: true)
        state.finishLoading(with: makeResponse(logs: [
            makeLog(id: "older", createdAt: 1_000),
            makeLog(id: "newer", createdAt: 2_000)
        ]))

        XCTAssertEqual(state.loadState, .loaded)
        XCTAssertEqual(state.logs.map(\.id), ["newer", "older"])
        XCTAssertEqual(state.selectedLogID, "newer")
    }

    func testLoadStateSwitchesBetweenLoadingEmptyAndFailed() {
        var state = MessageInspectorViewState()

        state.beginLoading(resetSelection: true)
        XCTAssertEqual(state.loadState, .loading)

        state.finishLoading(with: makeResponse(logs: []))
        XCTAssertEqual(state.loadState, .empty)
        XCTAssertNil(state.selectedLogID)

        state.beginLoading(resetSelection: true)
        state.finishLoading(with: nil)
        XCTAssertEqual(state.loadState, .failed)
        XCTAssertNil(state.selectedLogID)
    }

    func testSwitchingDetailTabsPreservesSelectedCall() {
        var state = MessageInspectorViewState()
        let newer = makeLog(id: "newer", createdAt: 2_000)
        let older = makeLog(id: "older", createdAt: 1_000)

        state.beginLoading(resetSelection: true)
        state.finishLoading(with: makeResponse(logs: [older, newer]))
        state.selectLog(id: "older")

        state.selectDetailTab(.prompt)
        state.selectDetailTab(.raw)

        XCTAssertEqual(state.selectedLogID, "older")
        XCTAssertEqual(state.selectedLog?.id, "older")
        XCTAssertEqual(state.selectedDetailTab, .raw)
    }

    private func makeResponse(logs: [LLMRequestLogEntry]) -> LLMContextResponse {
        LLMContextResponse(messageId: "message-1", logs: logs)
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
