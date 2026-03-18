import Foundation
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MockSettingsClient: SettingsClientProtocol {
    // MARK: - Spy State

    var fetchVercelConfigCallCount = 0
    var fetchModelInfoCallCount = 0
    var setModelCalls: [String] = []
    var setImageGenModelCalls: [String] = []
    var fetchTelegramConfigCallCount = 0
    var setTelegramConfigCalls: [(action: String, botToken: String?, commands: [TelegramConfigRequestCommand]?)] = []
    var setSlackWebhookConfigCalls: [(action: String, webhookUrl: String?)] = []
    var fetchChannelVerificationStatusCalls: [String] = []
    var saveVercelConfigCalls: [(action: String, apiToken: String?)] = []
    var sendChannelVerificationSessionCalls: [(action: String, channel: String?)] = []

    // MARK: - Configurable Responses

    var vercelConfigResponse: VercelApiConfigResponseMessage?
    var modelInfoResponse: ModelInfoMessage?
    var setModelResponse: ModelInfoMessage?
    var setImageGenModelResponse: ModelInfoMessage?
    var telegramConfigResponse: TelegramConfigResponseMessage?
    var setTelegramConfigResponse: TelegramConfigResponseMessage?
    var setSlackWebhookConfigResponse: Bool = true
    var channelVerificationResponses: [String: ChannelVerificationSessionResponseMessage] = [:]
    var saveVercelConfigResponse: VercelApiConfigResponseMessage?
    var sendChannelVerificationSessionResponse: ChannelVerificationSessionResponseMessage?

    // MARK: - Protocol Methods

    func fetchVercelConfig() async -> VercelApiConfigResponseMessage? {
        fetchVercelConfigCallCount += 1
        return vercelConfigResponse
    }

    func fetchModelInfo() async -> ModelInfoMessage? {
        fetchModelInfoCallCount += 1
        return modelInfoResponse
    }

    func setModel(model: String) async -> ModelInfoMessage? {
        setModelCalls.append(model)
        return setModelResponse
    }

    func setImageGenModel(modelId: String) async -> ModelInfoMessage? {
        setImageGenModelCalls.append(modelId)
        return setImageGenModelResponse
    }

    func fetchTelegramConfig() async -> TelegramConfigResponseMessage? {
        fetchTelegramConfigCallCount += 1
        return telegramConfigResponse
    }

    func setTelegramConfig(action: String, botToken: String?, commands: [TelegramConfigRequestCommand]?) async -> TelegramConfigResponseMessage? {
        setTelegramConfigCalls.append((action: action, botToken: botToken, commands: commands))
        return setTelegramConfigResponse
    }

    func setSlackWebhookConfig(action: String, webhookUrl: String?) async -> Bool {
        setSlackWebhookConfigCalls.append((action: action, webhookUrl: webhookUrl))
        return setSlackWebhookConfigResponse
    }

    func fetchChannelVerificationStatus(channel: String) async -> ChannelVerificationSessionResponseMessage? {
        fetchChannelVerificationStatusCalls.append(channel)
        return channelVerificationResponses[channel]
    }

    func saveVercelConfig(action: String, apiToken: String?) async -> VercelApiConfigResponseMessage? {
        saveVercelConfigCalls.append((action: action, apiToken: apiToken))
        return saveVercelConfigResponse
    }

    func sendChannelVerificationSession(action: String, channel: String?, conversationId: String?, rebind: Bool?, destination: String?, originConversationId: String?, purpose: String?, contactChannelId: String?) async -> ChannelVerificationSessionResponseMessage? {
        sendChannelVerificationSessionCalls.append((action: action, channel: channel))
        return sendChannelVerificationSessionResponse
    }
}
