import XCTest
@testable import VellumAssistantShared

final class SlackMessageMetadataDecodingTests: XCTestCase {
    func testHistoryMessageDecodesSlackMessageLinks() throws {
        let data = """
        {
          "id": "msg-123",
          "role": "user",
          "text": "Hello from Slack",
          "timestamp": 1710000000000,
          "slackMessage": {
            "channelId": "C123",
            "channelTs": "1710000000.000100",
            "threadTs": "1710000000.000001",
            "messageLink": {
              "appUrl": "slack://channel?team=T123&id=C123&message=1710000000.000100",
              "webUrl": "https://example.slack.com/archives/C123/p1710000000000100"
            },
            "threadLink": {
              "webUrl": "https://example.slack.com/archives/C123/p1710000000000001"
            }
          }
        }
        """.data(using: .utf8)!

        let message = try JSONDecoder().decode(HistoryResponseMessage.self, from: data)

        XCTAssertEqual(message.slackMessage?.channelId, "C123")
        XCTAssertEqual(message.slackMessage?.channelTs, "1710000000.000100")
        XCTAssertEqual(message.slackMessage?.threadTs, "1710000000.000001")
        XCTAssertEqual(
            message.slackMessage?.preferredMessageURL?.absoluteString,
            "https://example.slack.com/archives/C123/p1710000000000100"
        )
        XCTAssertEqual(
            message.slackMessage?.preferredThreadURL?.absoluteString,
            "https://example.slack.com/archives/C123/p1710000000000001"
        )
    }

    func testHistoryReconstructionPreservesSlackMessageMetadata() {
        let slackMessage = SlackMessageReference(
            channelId: "C123",
            channelTs: "1710000000.000100",
            messageLink: SlackDeepLinks(webUrl: "https://example.slack.com/archives/C123/p1710000000000100")
        )
        let history = HistoryResponseMessage(
            id: "msg-123",
            role: "user",
            text: "Hello from Slack",
            timestamp: 1710000000000,
            slackMessage: slackMessage
        )

        let result = HistoryReconstructionService.reconstructMessages(
            from: [history],
            conversationId: "conv-123"
        )

        XCTAssertEqual(result.messages.count, 1)
        XCTAssertEqual(result.messages[0].slackMessage, slackMessage)
        XCTAssertEqual(
            result.messages[0].slackMessage?.preferredMessageURL?.absoluteString,
            "https://example.slack.com/archives/C123/p1710000000000100"
        )
    }

    func testChannelBindingDecodesSlackThreadMetadata() throws {
        let data = """
        {
          "sourceChannel": "slack",
          "externalChatId": "C123",
          "externalThreadId": "1710000000.000001",
          "slackThread": {
            "channelId": "C123",
            "threadTs": "1710000000.000001",
            "link": {
              "webUrl": "https://example.slack.com/archives/C123/p1710000000000001"
            }
          }
        }
        """.data(using: .utf8)!

        let binding = try JSONDecoder().decode(ChannelBinding.self, from: data)

        XCTAssertEqual(binding.sourceChannel, "slack")
        XCTAssertEqual(binding.externalChatId, "C123")
        XCTAssertEqual(binding.externalThreadId, "1710000000.000001")
        XCTAssertEqual(binding.slackThread?.threadTs, "1710000000.000001")
        XCTAssertEqual(
            binding.slackThread?.link?.preferredURL?.absoluteString,
            "https://example.slack.com/archives/C123/p1710000000000001"
        )
    }
}
