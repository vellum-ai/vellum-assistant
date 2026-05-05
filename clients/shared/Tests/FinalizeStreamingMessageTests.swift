import XCTest
@testable import VellumAssistantShared

final class FinalizeStreamingMessageTests: XCTestCase {

    // MARK: - .all mode

    func testAllModeMarksNotStreamingAndClearsCodePreview() {
        var msg = ChatMessage(role: .assistant, text: "Hello", isStreaming: true)
        msg.streamingCodePreview = "let x = 1"
        msg.streamingCodeToolName = "bash"
        var messages = [msg]

        messages.finalizeStreamingMessage(id: msg.id)

        XCTAssertFalse(messages[0].isStreaming)
        XCTAssertNil(messages[0].streamingCodePreview)
        XCTAssertNil(messages[0].streamingCodeToolName)
    }

    func testAllModeCompletesAllIncompleteToolCalls() {
        var msg = ChatMessage(role: .assistant, text: "", isStreaming: true, toolCalls: [
            ToolCallData(toolName: "bash", inputSummary: "ls"),
            ToolCallData(toolName: "file_read", inputSummary: "/tmp/a.txt"),
        ])
        msg.toolCalls[0].isComplete = true
        msg.toolCalls[0].completedAt = Date()
        var messages = [msg]

        messages.finalizeStreamingMessage(id: msg.id)

        XCTAssertTrue(messages[0].toolCalls[0].isComplete, "Already-complete tool call stays complete")
        XCTAssertTrue(messages[0].toolCalls[1].isComplete, "Incomplete tool call should be completed")
        XCTAssertNotNil(messages[0].toolCalls[1].completedAt)
    }

    // MARK: - .previewOnly mode

    func testPreviewOnlyCompletesOnlyPreviewToolCalls() {
        var msg = ChatMessage(role: .assistant, text: "", isStreaming: true, toolCalls: [
            ToolCallData(toolName: "bash", inputSummary: "ls"),
            ToolCallData(toolName: "file_read", inputSummary: "/tmp/a.txt"),
        ])
        // First tool call: has toolUseId, no inputRawDict → preview-only, should be completed
        msg.toolCalls[0].toolUseId = "tool-1"
        msg.toolCalls[0].inputRawDict = nil
        // Second tool call: has toolUseId AND inputRawDict → daemon started executing, should NOT be completed
        msg.toolCalls[1].toolUseId = "tool-2"
        msg.toolCalls[1].inputRawDict = ["path": AnyCodable("/tmp/a.txt")]
        var messages = [msg]

        messages.finalizeStreamingMessage(id: msg.id, completeToolCalls: .previewOnly)

        XCTAssertTrue(messages[0].toolCalls[0].isComplete, "Preview-only tool call should be completed")
        XCTAssertNotNil(messages[0].toolCalls[0].completedAt)
        XCTAssertFalse(messages[0].toolCalls[1].isComplete, "Tool call with inputRawDict should NOT be completed in previewOnly mode")
    }

    func testPreviewOnlySkipsToolCallsWithoutToolUseId() {
        var msg = ChatMessage(role: .assistant, text: "", isStreaming: true, toolCalls: [
            ToolCallData(toolName: "bash", inputSummary: "ls"),
        ])
        // No toolUseId → not preview-only, should not be completed
        msg.toolCalls[0].toolUseId = nil
        msg.toolCalls[0].inputRawDict = nil
        var messages = [msg]

        messages.finalizeStreamingMessage(id: msg.id, completeToolCalls: .previewOnly)

        XCTAssertFalse(messages[0].toolCalls[0].isComplete, "Tool call without toolUseId should not be completed in previewOnly mode")
    }

    // MARK: - .none mode

    func testNoneModeDoesNotTouchToolCalls() {
        var msg = ChatMessage(role: .assistant, text: "", isStreaming: true, toolCalls: [
            ToolCallData(toolName: "bash", inputSummary: "ls"),
        ])
        var messages = [msg]

        messages.finalizeStreamingMessage(id: msg.id, completeToolCalls: .none)

        XCTAssertFalse(messages[0].isStreaming, "isStreaming should still be cleared")
        XCTAssertFalse(messages[0].toolCalls[0].isComplete, "Tool calls should not be touched in .none mode")
    }

    // MARK: - Edge cases

    func testNonexistentIdIsNoOp() {
        var msg = ChatMessage(role: .assistant, text: "Hello", isStreaming: true)
        var messages = [msg]
        let bogusId = UUID()

        messages.finalizeStreamingMessage(id: bogusId)

        XCTAssertTrue(messages[0].isStreaming, "Message should be unchanged when ID doesn't match")
    }

    func testOnlyTargetedMessageIsAffected() {
        var msg1 = ChatMessage(role: .assistant, text: "First", isStreaming: true)
        var msg2 = ChatMessage(role: .assistant, text: "Second", isStreaming: true)
        var messages = [msg1, msg2]

        messages.finalizeStreamingMessage(id: msg1.id)

        XCTAssertFalse(messages[0].isStreaming, "Targeted message should be finalized")
        XCTAssertTrue(messages[1].isStreaming, "Other message should be untouched")
    }
}
