import XCTest

@testable import VellumAssistantShared

final class GatewayConnectionManagerConversationForkDecodingTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testHTTPConversationsListResponseDecodesForkParent() throws {
        let data = Data(
            """
            {
              "conversations": [
                {
                  "id": "conv-child",
                  "title": "Forked thread",
                  "createdAt": 1700000000,
                  "updatedAt": 1700000100,
                  "forkParent": {
                    "conversationId": "conv-parent",
                    "messageId": "msg-parent",
                    "title": "Original thread"
                  }
                }
              ],
              "hasMore": false
            }
            """.utf8
        )

        let response = try decoder.decode(ConversationsListResponse.self, from: data)
        let conversation = try XCTUnwrap(response.conversations.first)

        XCTAssertEqual(conversation.forkParent?.conversationId, "conv-parent")
        XCTAssertEqual(conversation.forkParent?.messageId, "msg-parent")
        XCTAssertEqual(conversation.forkParent?.title, "Original thread")
    }

    func testConversationListTransportDecodesForkParent() throws {
        let data = Data(
            """
            {
              "type": "conversation_list_response",
              "conversations": [
                {
                  "id": "conv-child",
                  "title": "Forked thread",
                  "createdAt": 1700000000,
                  "updatedAt": 1700000100,
                  "forkParent": {
                    "conversationId": "conv-parent",
                    "messageId": "msg-parent",
                    "title": "Original thread"
                  }
                }
              ],
              "hasMore": false
            }
            """.utf8
        )

        let response = try decoder.decode(ConversationListResponse.self, from: data)
        let conversation = try XCTUnwrap(response.conversations.first)

        XCTAssertEqual(conversation.forkParent?.conversationId, "conv-parent")
        XCTAssertEqual(conversation.forkParent?.messageId, "msg-parent")
        XCTAssertEqual(conversation.forkParent?.title, "Original thread")
    }

    func testConversationListTransportDecodesWithoutForkParent() throws {
        let data = Data(
            """
            {
              "type": "conversation_list_response",
              "conversations": [
                {
                  "id": "conv-standard",
                  "title": "Standard thread",
                  "createdAt": 1700000000,
                  "updatedAt": 1700000100
                }
              ],
              "hasMore": false
            }
            """.utf8
        )

        let response = try decoder.decode(ConversationListResponse.self, from: data)
        let conversation = try XCTUnwrap(response.conversations.first)

        XCTAssertNil(conversation.forkParent)
    }

    func testSingleConversationResponseDecodesForkParent() throws {
        let data = Data(
            """
            {
              "conversation": {
                "id": "conv-child",
                "title": "Forked thread",
                "createdAt": 1700000000,
                "updatedAt": 1700000100,
                "forkParent": {
                  "conversationId": "conv-parent",
                  "messageId": "msg-parent",
                  "title": "Original thread"
                }
              }
            }
            """.utf8
        )

        let response = try decoder.decode(SingleConversationResponse.self, from: data)

        XCTAssertEqual(response.conversation.forkParent?.conversationId, "conv-parent")
        XCTAssertEqual(response.conversation.forkParent?.messageId, "msg-parent")
        XCTAssertEqual(response.conversation.forkParent?.title, "Original thread")
    }

    func testForkConversationResponseDecodesForkRoutePayloadShape() throws {
        let data = Data(
            """
            {
              "conversation": {
                "id": "conv-forked",
                "title": "Fork result",
                "createdAt": 1700000200,
                "updatedAt": 1700000300,
                "forkParent": {
                  "conversationId": "conv-parent",
                  "messageId": "msg-parent",
                  "title": "Original thread"
                }
              }
            }
            """.utf8
        )

        let response = try decoder.decode(ForkConversationResponse.self, from: data)

        XCTAssertEqual(response.conversation.id, "conv-forked")
        XCTAssertEqual(response.conversation.forkParent?.conversationId, "conv-parent")
        XCTAssertEqual(response.conversation.forkParent?.messageId, "msg-parent")
        XCTAssertEqual(response.conversation.forkParent?.title, "Original thread")
    }
}
