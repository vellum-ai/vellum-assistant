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
    var updateVoiceConfigCalls: [VoiceConfigUpdateRequest] = []
    var updateVoiceConfigResponse: Bool = true
    var startOAuthConnectCalls: [OAuthConnectStartRequest] = []
    var startOAuthConnectResponse: Bool = true
    var registerDeviceTokenCalls: [(token: String, platform: String)] = []
    var registerDeviceTokenResponse: Bool = true
    var fetchIngressConfigCallCount = 0
    var fetchIngressConfigResponse: IngressConfigResponseMessage?
    var updateIngressConfigCalls: [(publicBaseUrl: String?, enabled: Bool?)] = []
    var updateIngressConfigResponse: IngressConfigResponseMessage?
    var fetchSuggestionCalls: [(conversationId: String, requestId: String)] = []
    var fetchSuggestionResponse: SuggestionResponseMessage?

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

    func updateVoiceConfig(_ config: VoiceConfigUpdateRequest) async -> Bool {
        updateVoiceConfigCalls.append(config)
        return updateVoiceConfigResponse
    }

    func startOAuthConnect(_ request: OAuthConnectStartRequest) async -> Bool {
        startOAuthConnectCalls.append(request)
        return startOAuthConnectResponse
    }

    func registerDeviceToken(token: String, platform: String) async -> Bool {
        registerDeviceTokenCalls.append((token: token, platform: platform))
        return registerDeviceTokenResponse
    }

    func fetchIngressConfig() async -> IngressConfigResponseMessage? {
        fetchIngressConfigCallCount += 1
        return fetchIngressConfigResponse
    }

    func updateIngressConfig(publicBaseUrl: String?, enabled: Bool?) async -> IngressConfigResponseMessage? {
        updateIngressConfigCalls.append((publicBaseUrl: publicBaseUrl, enabled: enabled))
        return updateIngressConfigResponse
    }

    func fetchSuggestion(conversationId: String, requestId: String) async -> SuggestionResponseMessage? {
        fetchSuggestionCalls.append((conversationId: conversationId, requestId: requestId))
        return fetchSuggestionResponse
    }
}
