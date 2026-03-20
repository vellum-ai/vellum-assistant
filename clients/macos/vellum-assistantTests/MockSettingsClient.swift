import Foundation
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MockSettingsClient: SettingsClientProtocol {
    // MARK: - Spy State

    var fetchVercelConfigCallCount = 0
    var saveVercelConfigCalls: [String] = []
    var deleteVercelConfigCallCount = 0
    var fetchModelInfoCallCount = 0
    var setModelCalls: [(model: String, provider: String?)] = []
    var setImageGenModelCalls: [String] = []
    var fetchTelegramConfigCallCount = 0
    var setTelegramConfigCalls: [(action: String, botToken: String?, commands: [TelegramConfigRequestCommand]?)] = []
    var setSlackWebhookConfigCalls: [(action: String, webhookUrl: String?)] = []
    var fetchEmbeddingConfigCallCount = 0
    var setEmbeddingConfigCalls: [(provider: String, model: String?)] = []
    var fetchChannelVerificationStatusCalls: [String] = []
    var sendChannelVerificationSessionCalls: [(action: String, channel: String?, conversationId: String?, rebind: Bool?, destination: String?, originConversationId: String?, purpose: String?, contactChannelId: String?)] = []

    // MARK: - Configurable Responses

    var vercelConfigResponse: VercelApiConfigResponseMessage?
    var saveVercelConfigResponse: VercelApiConfigResponseMessage?
    var deleteVercelConfigResponse: VercelApiConfigResponseMessage?
    var modelInfoResponse: ModelInfoMessage?
    var setModelResponse: ModelInfoMessage?
    var setImageGenModelResponse: ModelInfoMessage?
    var embeddingConfigResponse: EmbeddingConfigMessage?
    var setEmbeddingConfigResponse: EmbeddingConfigMessage?
    var telegramConfigResponse: TelegramConfigResponseMessage?
    var setTelegramConfigResponse: TelegramConfigResponseMessage?
    var fetchDangerouslySkipPermissionsResponse: Bool?
    var setDangerouslySkipPermissionsResponse: Bool = true
    var fetchDangerouslySkipPermissionsCallCount = 0
    var setDangerouslySkipPermissionsCalls: [Bool] = []
    var setSlackWebhookConfigResponse: Bool = true
    var channelVerificationResponses: [String: ChannelVerificationSessionResponseMessage] = [:]
    var sendChannelVerificationSessionResponse: ChannelVerificationSessionResponseMessage?

    // MARK: - Protocol Methods

    func fetchVercelConfig() async -> VercelApiConfigResponseMessage? {
        fetchVercelConfigCallCount += 1
        return vercelConfigResponse
    }

    func saveVercelConfig(apiToken: String) async -> VercelApiConfigResponseMessage? {
        saveVercelConfigCalls.append(apiToken)
        return saveVercelConfigResponse
    }

    func deleteVercelConfig() async -> VercelApiConfigResponseMessage? {
        deleteVercelConfigCallCount += 1
        return deleteVercelConfigResponse
    }

    func fetchModelInfo() async -> ModelInfoMessage? {
        fetchModelInfoCallCount += 1
        return modelInfoResponse
    }

    func setModel(model: String, provider: String? = nil) async -> ModelInfoMessage? {
        setModelCalls.append((model: model, provider: provider))
        return setModelResponse
    }

    func setImageGenModel(modelId: String) async -> ModelInfoMessage? {
        setImageGenModelCalls.append(modelId)
        return setImageGenModelResponse
    }

    func fetchEmbeddingConfig() async -> EmbeddingConfigMessage? {
        fetchEmbeddingConfigCallCount += 1
        return embeddingConfigResponse
    }

    func setEmbeddingConfig(provider: String, model: String?) async -> EmbeddingConfigMessage? {
        setEmbeddingConfigCalls.append((provider: provider, model: model))
        return setEmbeddingConfigResponse
    }

    func fetchTelegramConfig() async -> TelegramConfigResponseMessage? {
        fetchTelegramConfigCallCount += 1
        return telegramConfigResponse
    }

    func setTelegramConfig(action: String, botToken: String?, commands: [TelegramConfigRequestCommand]?) async -> TelegramConfigResponseMessage? {
        setTelegramConfigCalls.append((action: action, botToken: botToken, commands: commands))
        return setTelegramConfigResponse
    }

    func fetchDangerouslySkipPermissions() async -> Bool? {
        fetchDangerouslySkipPermissionsCallCount += 1
        return fetchDangerouslySkipPermissionsResponse
    }

    func setDangerouslySkipPermissions(_ enabled: Bool) async -> Bool {
        setDangerouslySkipPermissionsCalls.append(enabled)
        return setDangerouslySkipPermissionsResponse
    }

    func setSlackWebhookConfig(action: String, webhookUrl: String?) async -> Bool {
        setSlackWebhookConfigCalls.append((action: action, webhookUrl: webhookUrl))
        return setSlackWebhookConfigResponse
    }

    func fetchChannelVerificationStatus(channel: String) async -> ChannelVerificationSessionResponseMessage? {
        fetchChannelVerificationStatusCalls.append(channel)
        return channelVerificationResponses[channel]
    }

    func sendChannelVerificationSession(
        action: String,
        channel: String?,
        conversationId: String?,
        rebind: Bool?,
        destination: String?,
        originConversationId: String?,
        purpose: String?,
        contactChannelId: String?
    ) async -> ChannelVerificationSessionResponseMessage? {
        sendChannelVerificationSessionCalls.append((
            action: action, channel: channel, conversationId: conversationId,
            rebind: rebind, destination: destination, originConversationId: originConversationId,
            purpose: purpose, contactChannelId: contactChannelId
        ))
        return sendChannelVerificationSessionResponse
    }
}
