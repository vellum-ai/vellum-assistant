import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class ACPMessagesTests: XCTestCase {

    // MARK: - Helpers

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func encodeToDict<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("Encoded value is not a JSON object")
            return [:]
        }
        return dict
    }

    // MARK: - ACPSessionState

    func test_acpSessionState_decodesAllFields() throws {
        let json = #"""
        {
          "id": "sess-1",
          "agentId": "claude-code",
          "acpSessionId": "acp-abc",
          "parentConversationId": "conv-xyz",
          "status": "running",
          "startedAt": 1700000000000,
          "completedAt": 1700000005000,
          "error": null,
          "stopReason": "end_turn"
        }
        """#

        let state = try decode(ACPSessionState.self, json)

        XCTAssertEqual(state.id, "sess-1")
        XCTAssertEqual(state.agentId, "claude-code")
        XCTAssertEqual(state.acpSessionId, "acp-abc")
        XCTAssertEqual(state.parentConversationId, "conv-xyz")
        XCTAssertEqual(state.status, .running)
        XCTAssertEqual(state.startedAt, 1_700_000_000_000)
        XCTAssertEqual(state.completedAt, 1_700_000_005_000)
        XCTAssertNil(state.error)
        XCTAssertEqual(state.stopReason, .endTurn)
    }

    func test_acpSessionState_decodesMinimalFields() throws {
        let json = #"""
        {
          "id": "sess-2",
          "agentId": "agent-x",
          "acpSessionId": "acp-2",
          "status": "initializing",
          "startedAt": 1700000000000
        }
        """#

        let state = try decode(ACPSessionState.self, json)

        XCTAssertEqual(state.status, .initializing)
        XCTAssertNil(state.parentConversationId)
        XCTAssertNil(state.completedAt)
        XCTAssertNil(state.error)
        XCTAssertNil(state.stopReason)
    }

    func test_acpSessionState_unknownStatus_fallsBackToUnknown() throws {
        let json = #"""
        {
          "id": "sess-3",
          "agentId": "a",
          "acpSessionId": "acp-3",
          "status": "future_status_value",
          "startedAt": 0
        }
        """#

        let state = try decode(ACPSessionState.self, json)
        XCTAssertEqual(state.status, .unknown)
    }

    func test_acpSessionState_unknownStopReason_fallsBackToUnknown() throws {
        let json = #"""
        {
          "id": "sess-4",
          "agentId": "a",
          "acpSessionId": "acp-4",
          "status": "completed",
          "startedAt": 0,
          "stopReason": "future_reason"
        }
        """#

        let state = try decode(ACPSessionState.self, json)
        XCTAssertEqual(state.stopReason, .unknown)
    }

    func test_acpSessionState_roundTrip_preservesEquality() throws {
        let original = ACPSessionState(
            id: "sess-rt",
            agentId: "a",
            acpSessionId: "acp-rt",
            parentConversationId: "conv-rt",
            status: .completed,
            startedAt: 1,
            completedAt: 2,
            error: "boom",
            stopReason: .maxTokens
        )

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ACPSessionState.self, from: data)

        XCTAssertEqual(decoded, original)
    }

    func test_acpSessionState_encode_writesSnakeCaseStopReason() throws {
        let state = ACPSessionState(
            id: "x",
            agentId: "a",
            acpSessionId: "acp-x",
            status: .completed,
            startedAt: 0,
            stopReason: .maxTurnRequests
        )

        let dict = try encodeToDict(state)
        XCTAssertEqual(dict["stopReason"] as? String, "max_turn_requests")
        XCTAssertEqual(dict["status"] as? String, "completed")
    }

    // MARK: - ACPSessionSpawnedMessage

    func test_acpSessionSpawned_decodes() throws {
        let json = #"""
        {
          "acpSessionId": "acp-spawn",
          "agent": "claude-code",
          "parentConversationId": "conv-1"
        }
        """#

        let msg = try decode(ACPSessionSpawnedMessage.self, json)

        XCTAssertEqual(msg.acpSessionId, "acp-spawn")
        XCTAssertEqual(msg.agent, "claude-code")
        XCTAssertEqual(msg.parentConversationId, "conv-1")
    }

    func test_acpSessionSpawned_roundTrip() throws {
        let original = ACPSessionSpawnedMessage(
            acpSessionId: "acp-spawn",
            agent: "claude-code",
            parentConversationId: "conv-1"
        )

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ACPSessionSpawnedMessage.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    // MARK: - ACPSessionUpdateMessage

    func test_acpSessionUpdate_decodes_agentMessageChunk() throws {
        let json = #"""
        {
          "acpSessionId": "acp-1",
          "updateType": "agent_message_chunk",
          "content": "Hello, world"
        }
        """#

        let msg = try decode(ACPSessionUpdateMessage.self, json)

        XCTAssertEqual(msg.acpSessionId, "acp-1")
        XCTAssertEqual(msg.updateType, .agentMessageChunk)
        XCTAssertEqual(msg.content, "Hello, world")
        XCTAssertNil(msg.toolCallId)
    }

    func test_acpSessionUpdate_decodes_agentThoughtChunk() throws {
        let json = #"""
        {
          "acpSessionId": "acp-1",
          "updateType": "agent_thought_chunk",
          "content": "Reasoning..."
        }
        """#

        let msg = try decode(ACPSessionUpdateMessage.self, json)
        XCTAssertEqual(msg.updateType, .agentThoughtChunk)
        XCTAssertEqual(msg.content, "Reasoning...")
    }

    func test_acpSessionUpdate_decodes_toolCall() throws {
        let json = #"""
        {
          "acpSessionId": "acp-1",
          "updateType": "tool_call",
          "toolCallId": "call-1",
          "toolTitle": "Read file",
          "toolKind": "read",
          "toolStatus": "in_progress"
        }
        """#

        let msg = try decode(ACPSessionUpdateMessage.self, json)
        XCTAssertEqual(msg.updateType, .toolCall)
        XCTAssertEqual(msg.toolCallId, "call-1")
        XCTAssertEqual(msg.toolTitle, "Read file")
        XCTAssertEqual(msg.toolKind, "read")
        XCTAssertEqual(msg.toolStatus, "in_progress")
        XCTAssertNil(msg.content)
    }

    func test_acpSessionUpdate_decodes_allKnownUpdateTypes() throws {
        let cases: [(String, ACPSessionUpdateMessage.UpdateType)] = [
            ("agent_message_chunk", .agentMessageChunk),
            ("agent_thought_chunk", .agentThoughtChunk),
            ("user_message_chunk", .userMessageChunk),
            ("tool_call", .toolCall),
            ("tool_call_update", .toolCallUpdate),
            ("plan", .plan)
        ]

        for (raw, expected) in cases {
            let json = #"{"acpSessionId":"x","updateType":"\#(raw)"}"#
            let msg = try decode(ACPSessionUpdateMessage.self, json)
            XCTAssertEqual(msg.updateType, expected, "failed for raw=\(raw)")
        }
    }

    func test_acpSessionUpdate_unknownUpdateType_fallsBackToUnknown() throws {
        let json = #"""
        {
          "acpSessionId": "acp-1",
          "updateType": "future_update_kind"
        }
        """#

        let msg = try decode(ACPSessionUpdateMessage.self, json)
        XCTAssertEqual(msg.updateType, .unknown)
    }

    func test_acpSessionUpdate_synthesizesUniqueIdsAtDecode() throws {
        let json = #"""
        {
          "acpSessionId": "acp-1",
          "updateType": "plan"
        }
        """#

        let a = try decode(ACPSessionUpdateMessage.self, json)
        let b = try decode(ACPSessionUpdateMessage.self, json)
        XCTAssertNotEqual(a.id, b.id, "Each decode should generate a fresh id for SwiftUI diffing")
        // Equality is content-based, so the two decodes are still equal.
        XCTAssertEqual(a, b)
    }

    func test_acpSessionUpdate_idIsNotPartOfWireFormat() throws {
        let original = ACPSessionUpdateMessage(
            acpSessionId: "acp-1",
            updateType: .agentMessageChunk,
            content: "hi"
        )
        let dict = try encodeToDict(original)
        XCTAssertNil(dict["id"], "Synthetic id should not appear in encoded JSON")
    }

    func test_acpSessionUpdate_roundTrip_preservesContent() throws {
        let original = ACPSessionUpdateMessage(
            acpSessionId: "acp-1",
            updateType: .toolCallUpdate,
            content: nil,
            toolCallId: "call-1",
            toolTitle: "Edit file",
            toolKind: "edit",
            toolStatus: "completed"
        )

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ACPSessionUpdateMessage.self, from: data)
        // Equality compares wire fields, not the synthetic id.
        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.updateType, .toolCallUpdate)
        XCTAssertEqual(decoded.toolCallId, "call-1")
    }

    // MARK: - ACPSessionCompletedMessage

    func test_acpSessionCompleted_decodes() throws {
        let json = #"""
        {
          "acpSessionId": "acp-c",
          "stopReason": "end_turn"
        }
        """#

        let msg = try decode(ACPSessionCompletedMessage.self, json)

        XCTAssertEqual(msg.acpSessionId, "acp-c")
        XCTAssertEqual(msg.stopReason, .endTurn)
    }

    func test_acpSessionCompleted_decodesAllStopReasons() throws {
        let cases: [(String, ACPSessionState.StopReason)] = [
            ("end_turn", .endTurn),
            ("max_tokens", .maxTokens),
            ("max_turn_requests", .maxTurnRequests),
            ("refusal", .refusal),
            ("cancelled", .cancelled)
        ]

        for (raw, expected) in cases {
            let json = #"{"acpSessionId":"x","stopReason":"\#(raw)"}"#
            let msg = try decode(ACPSessionCompletedMessage.self, json)
            XCTAssertEqual(msg.stopReason, expected, "failed for raw=\(raw)")
        }
    }

    func test_acpSessionCompleted_roundTrip() throws {
        let original = ACPSessionCompletedMessage(
            acpSessionId: "acp-c",
            stopReason: .cancelled
        )

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ACPSessionCompletedMessage.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    // MARK: - ACPSessionErrorMessage

    func test_acpSessionError_decodes() throws {
        let json = #"""
        {
          "acpSessionId": "acp-e",
          "error": "agent crashed"
        }
        """#

        let msg = try decode(ACPSessionErrorMessage.self, json)
        XCTAssertEqual(msg.acpSessionId, "acp-e")
        XCTAssertEqual(msg.error, "agent crashed")
    }

    func test_acpSessionError_roundTrip() throws {
        let original = ACPSessionErrorMessage(
            acpSessionId: "acp-e",
            error: "spawn failed"
        )

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ACPSessionErrorMessage.self, from: data)
        XCTAssertEqual(decoded, original)
    }
}
