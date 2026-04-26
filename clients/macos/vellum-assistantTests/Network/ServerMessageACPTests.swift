import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class ServerMessageACPTests: XCTestCase {

    // MARK: - Helpers

    private func decodeMessage(_ json: String) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
    }

    // MARK: - acp_session_spawned

    func test_decodes_acpSessionSpawned() throws {
        let json = #"""
        {
          "type": "acp_session_spawned",
          "acpSessionId": "acp-spawn",
          "agent": "claude-code",
          "parentConversationId": "conv-1"
        }
        """#

        let msg = try decodeMessage(json)

        guard case .acpSessionSpawned(let payload) = msg else {
            XCTFail("Expected .acpSessionSpawned, got \(msg)")
            return
        }
        XCTAssertEqual(payload.acpSessionId, "acp-spawn")
        XCTAssertEqual(payload.agent, "claude-code")
        XCTAssertEqual(payload.parentConversationId, "conv-1")
    }

    // MARK: - acp_session_update

    func test_decodes_acpSessionUpdate_agentMessageChunk() throws {
        let json = #"""
        {
          "type": "acp_session_update",
          "acpSessionId": "acp-1",
          "updateType": "agent_message_chunk",
          "content": "Hello, world"
        }
        """#

        let msg = try decodeMessage(json)

        guard case .acpSessionUpdate(let payload) = msg else {
            XCTFail("Expected .acpSessionUpdate, got \(msg)")
            return
        }
        XCTAssertEqual(payload.acpSessionId, "acp-1")
        XCTAssertEqual(payload.updateType, .agentMessageChunk)
        XCTAssertEqual(payload.content, "Hello, world")
    }

    func test_decodes_acpSessionUpdate_toolCall() throws {
        let json = #"""
        {
          "type": "acp_session_update",
          "acpSessionId": "acp-1",
          "updateType": "tool_call",
          "toolCallId": "call-1",
          "toolTitle": "Read file",
          "toolKind": "read",
          "toolStatus": "in_progress"
        }
        """#

        let msg = try decodeMessage(json)

        guard case .acpSessionUpdate(let payload) = msg else {
            XCTFail("Expected .acpSessionUpdate, got \(msg)")
            return
        }
        XCTAssertEqual(payload.updateType, .toolCall)
        XCTAssertEqual(payload.toolCallId, "call-1")
        XCTAssertEqual(payload.toolTitle, "Read file")
        XCTAssertEqual(payload.toolKind, "read")
        XCTAssertEqual(payload.toolStatus, "in_progress")
    }

    // MARK: - acp_session_completed

    func test_decodes_acpSessionCompleted() throws {
        let json = #"""
        {
          "type": "acp_session_completed",
          "acpSessionId": "acp-c",
          "stopReason": "end_turn"
        }
        """#

        let msg = try decodeMessage(json)

        guard case .acpSessionCompleted(let payload) = msg else {
            XCTFail("Expected .acpSessionCompleted, got \(msg)")
            return
        }
        XCTAssertEqual(payload.acpSessionId, "acp-c")
        XCTAssertEqual(payload.stopReason, .endTurn)
    }

    // MARK: - acp_session_error

    func test_decodes_acpSessionError() throws {
        let json = #"""
        {
          "type": "acp_session_error",
          "acpSessionId": "acp-e",
          "error": "agent crashed"
        }
        """#

        let msg = try decodeMessage(json)

        guard case .acpSessionError(let payload) = msg else {
            XCTFail("Expected .acpSessionError, got \(msg)")
            return
        }
        XCTAssertEqual(payload.acpSessionId, "acp-e")
        XCTAssertEqual(payload.error, "agent crashed")
    }

    // MARK: - Forward compatibility

    /// Unrecognized `acp_session_*` types must fall through to `.unknown(...)`
    /// so a daemon emitting a new ACP event variant cannot crash older clients.
    func test_unknownAcpSessionType_fallsBackToUnknown() throws {
        let json = #"""
        {
          "type": "acp_session_future_event",
          "acpSessionId": "acp-x"
        }
        """#

        let msg = try decodeMessage(json)

        guard case .unknown(let type) = msg else {
            XCTFail("Expected .unknown, got \(msg)")
            return
        }
        XCTAssertEqual(type, "acp_session_future_event")
    }
}
