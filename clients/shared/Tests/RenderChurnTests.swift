import XCTest
@testable import VellumAssistantShared

/// Regression tests for render-churn reduction and memory-retention fixes.
/// Validates: SubagentDetailStore coalesced event recording, stripHeavyContent surface stripping,
/// attachment lifecycle clearing guards, ToolCallData Equatable exclusions, and
/// ChatMessage.toolCallsRevision O(1) equality.
@MainActor
final class RenderChurnTests: XCTestCase {

    // MARK: - SubagentDetailStore coalesced event recording

    /// Rapid-fire text deltas should accumulate into a single text event per subagent
    /// and be coalesced into a single flush to the per-subagent state within the 100ms window.
    func testSubagentDetailStoreCoalescesTextDeltas() async {
        let store = SubagentDetailStore()

        for i in 0..<10 {
            store.handleEvent(
                subagentId: "agent-1",
                event: .assistantTextDelta(AssistantTextDeltaMessage(text: "chunk-\(i)"))
            )
        }

        // Before the flush fires, the per-subagent state should have no events yet.
        XCTAssertTrue(
            (store.subagentStates["agent-1"]?.events ?? []).isEmpty,
            "Events should be staged, not yet flushed to the per-subagent state"
        )

        // Wait 200ms (2x the 100ms coalesce window) for the flush to fire.
        try? await Task.sleep(nanoseconds: 200_000_000)

        let events = store.subagentStates["agent-1"]?.events ?? []
        XCTAssertEqual(events.count, 1, "Text deltas should accumulate into a single text event")
        XCTAssertTrue(events[0].content.contains("chunk-9"), "Final chunk should be present in accumulated text")
    }

    // MARK: - stripHeavyContent surface stripping

    /// Completed surfaces (non-nil completionState) should have their data replaced
    /// with .stripped and actions cleared. Active surfaces should retain their data.
    func testStripHeavyContentStripsCompletedSurfaces() {
        let dynamicPageData = DynamicPageSurfaceData(
            html: "<html><body>Heavy payload</body></html>",
            width: 800,
            height: 600
        )
        let action = SurfaceActionButton(id: "btn-1", label: "Submit", style: .primary)

        let completedSurface = InlineSurfaceData(
            id: "surface-completed",
            surfaceType: .dynamicPage,
            title: "Completed App",
            data: .dynamicPage(dynamicPageData),
            actions: [action],
            completionState: SurfaceCompletionState(summary: "Done")
        )

        let activeSurface = InlineSurfaceData(
            id: "surface-active",
            surfaceType: .dynamicPage,
            title: "Active App",
            data: .dynamicPage(dynamicPageData),
            actions: [action]
        )

        var message = ChatMessage(
            role: .assistant,
            text: "Here is your app",
            inlineSurfaces: [completedSurface, activeSurface]
        )

        message.stripHeavyContent()

        // Completed surface should be stripped.
        XCTAssertEqual(message.inlineSurfaces[0].data, .stripped,
                       "Completed surface data should be .stripped")
        XCTAssertTrue(message.inlineSurfaces[0].actions.isEmpty,
                      "Completed surface actions should be cleared")

        // Active surface (no completionState) should retain its data.
        if case .dynamicPage(let dp) = message.inlineSurfaces[1].data {
            XCTAssertEqual(dp.html, "<html><body>Heavy payload</body></html>",
                           "Active surface should retain its HTML payload")
        } else {
            XCTFail("Active surface data should still be .dynamicPage, got \(message.inlineSurfaces[1].data)")
        }
        XCTAssertEqual(message.inlineSurfaces[1].actions.count, 1,
                       "Active surface should retain its actions")
    }

    /// Calling stripHeavyContent twice should be a no-op on the second call
    /// (isContentStripped guard).
    func testStripHeavyContentIsIdempotent() {
        var message = ChatMessage(
            role: .assistant,
            text: "Hello",
            toolCalls: [
                ToolCallData(toolName: "bash", inputSummary: "ls", result: "output")
            ]
        )

        message.stripHeavyContent()
        XCTAssertTrue(message.isContentStripped)
        XCTAssertNil(message.toolCalls[0].result)

        // Mutate after first strip to prove second call is a no-op.
        message.toolCalls[0].result = "re-added"
        message.stripHeavyContent()
        XCTAssertEqual(message.toolCalls[0].result, "re-added",
                       "Second stripHeavyContent should be a no-op due to isContentStripped guard")
    }

    // MARK: - Attachment clearing guards (sizeBytes gate)

    /// Lazy-loadable attachments (sizeBytes != nil) should have data cleared after
    /// the dequeue/message-complete path, while locally-created attachments
    /// (sizeBytes == nil) should retain their data.
    func testAttachmentClearingRespectsLazyLoadGuard() {
        // Lazy-loadable attachment (daemon-served, sizeBytes present).
        var lazyAttachment = ChatAttachment(
            id: "att-lazy",
            filename: "photo.png",
            mimeType: "image/png",
            data: "base64encodeddata",
            thumbnailData: nil,
            dataLength: 17,
            sizeBytes: 1024,
            thumbnailImage: nil
        )

        // Locally-created attachment (sizeBytes nil).
        var localAttachment = ChatAttachment(
            id: "att-local",
            filename: "note.txt",
            mimeType: "text/plain",
            data: "local file data",
            thumbnailData: nil,
            dataLength: 15,
            sizeBytes: nil,
            thumbnailImage: nil
        )

        // Simulate the dequeue clearing logic: only clear if sizeBytes != nil.
        if lazyAttachment.sizeBytes != nil {
            lazyAttachment.data = ""
            lazyAttachment.dataLength = 0
        }

        if localAttachment.sizeBytes != nil {
            localAttachment.data = ""
            localAttachment.dataLength = 0
        }

        // Lazy-loadable should be cleared.
        XCTAssertEqual(lazyAttachment.data, "",
                       "Lazy-loadable attachment data should be cleared")
        XCTAssertEqual(lazyAttachment.dataLength, 0,
                       "Lazy-loadable attachment dataLength should be zeroed")
        XCTAssertTrue(lazyAttachment.isLazyLoad,
                      "Cleared lazy attachment should report isLazyLoad = true")

        // Locally-created should NOT be cleared.
        XCTAssertEqual(localAttachment.data, "local file data",
                       "Local attachment data should NOT be cleared")
        XCTAssertEqual(localAttachment.dataLength, 15,
                       "Local attachment dataLength should be preserved")
        XCTAssertFalse(localAttachment.isLazyLoad,
                       "Local attachment with data should report isLazyLoad = false")
    }

    // MARK: - ToolCallData Equatable (imageDataList excluded)

    /// Two ToolCallData instances that differ only in imageDataList should be equal
    /// because imageDataList is intentionally excluded from the == implementation.
    func testToolCallDataEqualityExcludesImageDataList() {
        let id = UUID()
        let a = ToolCallData(
            id: id,
            toolName: "browser_screenshot",
            inputSummary: "screenshot",
            result: nil,
            isError: false,
            isComplete: true,
            arrivedBeforeText: true,
            imageDataList: ["AAAA"]
        )
        let b = ToolCallData(
            id: id,
            toolName: "browser_screenshot",
            inputSummary: "screenshot",
            result: nil,
            isError: false,
            isComplete: true,
            arrivedBeforeText: true,
            imageDataList: ["BBBB"]
        )

        XCTAssertEqual(a, b,
                       "ToolCallData instances differing only in imageDataList should be equal")
    }

    /// Two ToolCallData instances that differ in toolName should NOT be equal.
    func testToolCallDataInequalityOnToolName() {
        let id = UUID()
        let a = ToolCallData(
            id: id,
            toolName: "bash",
            inputSummary: "ls",
            result: nil,
            isError: false,
            isComplete: true,
            arrivedBeforeText: true
        )
        let b = ToolCallData(
            id: id,
            toolName: "file_read",
            inputSummary: "ls",
            result: nil,
            isError: false,
            isComplete: true,
            arrivedBeforeText: true
        )

        XCTAssertNotEqual(a, b,
                          "ToolCallData instances differing in toolName should NOT be equal")
    }

    // MARK: - ChatMessage toolCallsRevision

    /// ChatMessages with identical content should compare equal via toolCallsRevision.
    func testChatMessageEqualityWithSameToolCalls() {
        // GIVEN two messages constructed with identical tool calls
        let tcId = UUID()
        let msgId = UUID()
        let a = ChatMessage(
            id: msgId,
            role: .assistant,
            text: "Hello",
            toolCalls: [ToolCallData(id: tcId, toolName: "bash", inputSummary: "ls", isComplete: true)]
        )
        let b = ChatMessage(
            id: msgId,
            role: .assistant,
            text: "Hello",
            toolCalls: [ToolCallData(id: tcId, toolName: "bash", inputSummary: "ls", isComplete: true)]
        )

        // WHEN we compare them
        // THEN they should be equal (same fingerprint)
        XCTAssertEqual(a, b)
    }

    /// Mutating a tool call property should make the message compare as not-equal.
    func testChatMessageInequalityAfterToolCallMutation() {
        // GIVEN a message with a tool call
        var a = ChatMessage(
            role: .assistant,
            text: "Hello",
            toolCalls: [ToolCallData(toolName: "bash", inputSummary: "ls")]
        )
        let revisionBefore = a.toolCallsRevision

        // WHEN we mutate a tool call property
        a.toolCalls[0].isComplete = true

        // THEN the revision should have changed
        XCTAssertNotEqual(a.toolCallsRevision, revisionBefore)
    }

    /// Appending a tool call should bump the revision.
    func testChatMessageRevisionBumpsOnAppend() {
        // GIVEN a message with no tool calls
        var message = ChatMessage(role: .assistant, text: "Hello")
        let revisionBefore = message.toolCallsRevision

        // WHEN we append a tool call
        message.toolCalls.append(ToolCallData(toolName: "bash", inputSummary: "ls"))

        // THEN the revision should have changed
        XCTAssertNotEqual(message.toolCallsRevision, revisionBefore)
    }

    /// Messages constructed with different tool call content should have different revisions.
    func testChatMessageDifferentToolCallContentProducesDifferentRevisions() {
        // GIVEN two messages with different tool call arrays
        let msgId = UUID()
        let a = ChatMessage(
            id: msgId,
            role: .assistant,
            text: "Hello",
            toolCalls: [ToolCallData(toolName: "bash", inputSummary: "ls", isComplete: false)]
        )
        let b = ChatMessage(
            id: msgId,
            role: .assistant,
            text: "Hello",
            toolCalls: [ToolCallData(toolName: "bash", inputSummary: "ls", isComplete: true)]
        )

        // WHEN we compare their revisions
        // THEN they should differ (different isComplete → different fingerprint)
        XCTAssertNotEqual(a.toolCallsRevision, b.toolCallsRevision)
    }

    /// Messages with different tool call counts should have different revisions.
    func testChatMessageDifferentToolCallCountProducesDifferentRevisions() {
        // GIVEN two messages with different numbers of tool calls
        let msgId = UUID()
        let a = ChatMessage(
            id: msgId,
            role: .assistant,
            text: "Hello",
            toolCalls: [ToolCallData(toolName: "bash", inputSummary: "ls")]
        )
        let b = ChatMessage(
            id: msgId,
            role: .assistant,
            text: "Hello",
            toolCalls: [
                ToolCallData(toolName: "bash", inputSummary: "ls"),
                ToolCallData(toolName: "file_read", inputSummary: "cat")
            ]
        )

        // WHEN we compare their revisions
        // THEN they should differ (different count)
        XCTAssertNotEqual(a.toolCallsRevision, b.toolCallsRevision)
    }

    // MARK: - ToolCallData Equatable (inputFullLength sentinel)

    /// Two ToolCallData instances that differ in inputFullLength should NOT be equal
    /// (detects rehydration changes without comparing full strings).
    func testToolCallDataInequalityOnInputFullLength() {
        let id = UUID()
        var a = ToolCallData(
            id: id,
            toolName: "bash",
            inputSummary: "ls",
            inputFull: "ls -la",
            result: nil,
            isError: false,
            isComplete: true,
            arrivedBeforeText: true
        )
        var b = ToolCallData(
            id: id,
            toolName: "bash",
            inputSummary: "ls",
            inputFull: "",
            result: nil,
            isError: false,
            isComplete: true,
            arrivedBeforeText: true
        )

        // Manually set inputFullLength to simulate rehydration difference.
        a.inputFullLength = 6
        b.inputFullLength = 0

        XCTAssertNotEqual(a, b,
                          "ToolCallData instances differing in inputFullLength should NOT be equal (rehydration sentinel)")
    }
}
