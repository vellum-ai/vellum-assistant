import XCTest

@testable import VellumAssistantShared

/// Decoding contract for the per-conversation `inferenceProfile` field across
/// the conversation transport DTOs surfaced to the macOS client.
///
/// The HTTP route `PUT /v1/conversations/:id/inference-profile` returns
/// `{ conversationId, profile }`, and conversation list/detail/fork endpoints
/// surface the field as an optional `inferenceProfile` so older daemons
/// (which omit the field entirely) continue to decode cleanly.
final class HTTPDaemonClientInferenceProfileDecodingTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: - Setter response

    func testSetInferenceProfileResponseDecodesProfile() throws {
        let data = Data(
            """
            {
              "conversationId": "conv-1",
              "profile": "balanced"
            }
            """.utf8
        )

        let response = try decoder.decode(ConversationInferenceProfileResponse.self, from: data)

        XCTAssertEqual(response.conversationId, "conv-1")
        XCTAssertEqual(response.profile, "balanced")
    }

    func testSetInferenceProfileResponseDecodesNullProfile() throws {
        let data = Data(
            """
            {
              "conversationId": "conv-1",
              "profile": null
            }
            """.utf8
        )

        let response = try decoder.decode(ConversationInferenceProfileResponse.self, from: data)

        XCTAssertEqual(response.conversationId, "conv-1")
        XCTAssertNil(response.profile)
    }

    func testSetInferenceProfileResponseDecodesMissingProfileAsNil() throws {
        // The field is optional on the wire — an older daemon (or a future
        // route that uses a different shape) might omit it; we expect nil.
        let data = Data(
            """
            {
              "conversationId": "conv-1"
            }
            """.utf8
        )

        let response = try decoder.decode(ConversationInferenceProfileResponse.self, from: data)

        XCTAssertEqual(response.conversationId, "conv-1")
        XCTAssertNil(response.profile)
    }

    // MARK: - Conversation list payload

    func testConversationsListResponseDecodesInferenceProfile() throws {
        let data = Data(
            """
            {
              "conversations": [
                {
                  "id": "conv-1",
                  "title": "With profile",
                  "createdAt": 1700000000,
                  "updatedAt": 1700000100,
                  "inferenceProfile": "quality-optimized"
                }
              ],
              "hasMore": false
            }
            """.utf8
        )

        let response = try decoder.decode(ConversationsListResponse.self, from: data)
        let conversation = try XCTUnwrap(response.conversations.first)

        XCTAssertEqual(conversation.inferenceProfile, "quality-optimized")
    }

    func testConversationsListResponseDecodesWithoutInferenceProfile() throws {
        // Backwards-compatibility: pre-PR-16 daemons omit the field entirely.
        let data = Data(
            """
            {
              "conversations": [
                {
                  "id": "conv-2",
                  "title": "Without profile",
                  "createdAt": 1700000000,
                  "updatedAt": 1700000100
                }
              ],
              "hasMore": false
            }
            """.utf8
        )

        let response = try decoder.decode(ConversationsListResponse.self, from: data)
        let conversation = try XCTUnwrap(response.conversations.first)

        XCTAssertNil(conversation.inferenceProfile)
    }

    // MARK: - Single conversation payload (used by ConversationDetailClient)

    func testSingleConversationResponseDecodesInferenceProfile() throws {
        let data = Data(
            """
            {
              "conversation": {
                "id": "conv-3",
                "title": "Detail",
                "createdAt": 1700000000,
                "updatedAt": 1700000100,
                "inferenceProfile": "cost-optimized"
              }
            }
            """.utf8
        )

        let response = try decoder.decode(SingleConversationResponse.self, from: data)

        XCTAssertEqual(response.conversation.inferenceProfile, "cost-optimized")
    }

    // MARK: - Server-pushed event

    func testConversationListResponseTransportDecodesInferenceProfile() throws {
        let data = Data(
            """
            {
              "type": "conversation_list_response",
              "conversations": [
                {
                  "id": "conv-4",
                  "title": "Transport",
                  "createdAt": 1700000000,
                  "updatedAt": 1700000100,
                  "inferenceProfile": "balanced"
                }
              ],
              "hasMore": false
            }
            """.utf8
        )

        let response = try decoder.decode(ConversationListResponse.self, from: data)
        let conversation = try XCTUnwrap(response.conversations.first)

        XCTAssertEqual(conversation.inferenceProfile, "balanced")
    }

    func testServerMessageDecodesConversationInferenceProfileUpdated() throws {
        let data = Data(
            """
            {
              "type": "conversation_inference_profile_updated",
              "conversationId": "conv-5",
              "profile": "quality-optimized"
            }
            """.utf8
        )

        let message = try decoder.decode(ServerMessage.self, from: data)
        guard case .conversationInferenceProfileUpdated(let payload) = message else {
            return XCTFail("Expected .conversationInferenceProfileUpdated, got \(message)")
        }

        XCTAssertEqual(payload.conversationId, "conv-5")
        XCTAssertEqual(payload.profile, "quality-optimized")
    }

    func testServerMessageDecodesConversationInferenceProfileUpdatedWithNullProfile() throws {
        let data = Data(
            """
            {
              "type": "conversation_inference_profile_updated",
              "conversationId": "conv-5",
              "profile": null
            }
            """.utf8
        )

        let message = try decoder.decode(ServerMessage.self, from: data)
        guard case .conversationInferenceProfileUpdated(let payload) = message else {
            return XCTFail("Expected .conversationInferenceProfileUpdated, got \(message)")
        }

        XCTAssertEqual(payload.conversationId, "conv-5")
        XCTAssertNil(payload.profile)
    }
}
