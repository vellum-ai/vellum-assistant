import Foundation
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MockSettingsClient: SettingsClientProtocol {
    // MARK: - Spy State

    var fetchVercelConfigCallCount = 0
    var fetchModelInfoCallCount = 0
    var fetchTelegramConfigCallCount = 0
    var fetchChannelVerificationStatusCalls: [String] = []

    // MARK: - Configurable Responses

    var vercelConfigResponse: VercelApiConfigResponseMessage?
    var modelInfoResponse: ModelInfoMessage?
    var telegramConfigResponse: TelegramConfigResponseMessage?
    var channelVerificationResponses: [String: ChannelVerificationSessionResponseMessage] = [:]

    // MARK: - Protocol Methods

    func fetchVercelConfig() async -> VercelApiConfigResponseMessage? {
        fetchVercelConfigCallCount += 1
        return vercelConfigResponse
    }

    func fetchModelInfo() async -> ModelInfoMessage? {
        fetchModelInfoCallCount += 1
        return modelInfoResponse
    }

    func fetchTelegramConfig() async -> TelegramConfigResponseMessage? {
        fetchTelegramConfigCallCount += 1
        return telegramConfigResponse
    }

    func fetchChannelVerificationStatus(channel: String) async -> ChannelVerificationSessionResponseMessage? {
        fetchChannelVerificationStatusCalls.append(channel)
        return channelVerificationResponses[channel]
    }
}
