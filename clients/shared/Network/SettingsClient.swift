import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "SettingsClient")

/// Focused client for settings-related operations routed through the gateway.
///
/// Covers Vercel API config, model info, Telegram config, and channel
/// verification status — the endpoints invoked during `SettingsStore.init()`.
public protocol SettingsClientProtocol {
    func fetchVercelConfig() async -> VercelApiConfigResponseMessage?
    func saveVercelConfig(apiToken: String) async -> VercelApiConfigResponseMessage?
    func deleteVercelConfig() async -> VercelApiConfigResponseMessage?
    func fetchModelInfo() async -> ModelInfoMessage?
    func setModel(model: String, provider: String?) async -> ModelInfoMessage?
    func setImageGenModel(modelId: String) async -> ModelInfoMessage?
    func fetchEmbeddingConfig() async -> EmbeddingConfigMessage?
    func setEmbeddingConfig(provider: String, model: String?) async -> EmbeddingConfigMessage?
    func fetchTelegramConfig() async -> TelegramConfigResponseMessage?
    func setTelegramConfig(action: String, botToken: String?, commands: [TelegramConfigRequestCommand]?) async -> TelegramConfigResponseMessage?
    func setSlackWebhookConfig(action: String, webhookUrl: String?) async -> Bool
    func fetchChannelVerificationStatus(channel: String) async -> ChannelVerificationSessionResponseMessage?
    func sendChannelVerificationSession(
        action: String,
        channel: String?,
        conversationId: String?,
        rebind: Bool?,
        destination: String?,
        originConversationId: String?,
        purpose: String?,
        contactChannelId: String?
    ) async -> ChannelVerificationSessionResponseMessage?

    func updateVoiceConfig(_ config: VoiceConfigUpdateRequest) async -> Bool
    func startOAuthConnect(_ request: OAuthConnectStartRequest) async -> Bool
    func registerDeviceToken(token: String, platform: String) async -> Bool
    func fetchIngressConfig() async -> IngressConfigResponseMessage?
    func updateIngressConfig(publicBaseUrl: String?, enabled: Bool?) async -> IngressConfigResponseMessage?
    func fetchSuggestion(conversationId: String, requestId: String) async -> SuggestionResponseMessage?
    func fetchPlatformConfig() async -> PlatformConfigResponseMessage?
    func setPlatformConfig(baseUrl: String) async -> PlatformConfigResponseMessage?
    func patchConfig(_ partial: [String: Any]) async -> Bool
    func replaceInferenceProfile(name: String, fragment: [String: Any]) async -> Bool
    func fetchConfig() async -> [String: Any]?
    func checkApiKeyExists(provider: String) async -> Bool
    func fetchCallSiteCatalog() async -> CallSiteCatalogResponse?
}

/// Gateway-backed implementation of ``SettingsClientProtocol``.
public struct SettingsClient: SettingsClientProtocol {
    nonisolated public init() {}

    private static let pathComponentAllowed: CharacterSet = {
        var cs = CharacterSet.urlPathAllowed
        cs.remove(charactersIn: "/")
        return cs
    }()

    private static func encodePath(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: pathComponentAllowed) ?? value
    }

    public func fetchVercelConfig() async -> VercelApiConfigResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "integrations/vercel/config", timeout: 10, unprefixed: true
            )
            guard response.isSuccess else {
                log.error("fetchVercelConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("vercel_api_config_response", into: response.data)
            return try JSONDecoder().decode(VercelApiConfigResponseMessage.self, from: patched)
        } catch {
            log.error("fetchVercelConfig error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func saveVercelConfig(apiToken: String) async -> VercelApiConfigResponseMessage? {
        do {
            let body: [String: Any] = ["type": "vercel_api_config", "action": "set", "apiToken": apiToken]
            let response = try await GatewayHTTPClient.post(
                path: "integrations/vercel/config", json: body, timeout: 10, unprefixed: true
            )
            guard response.isSuccess else {
                log.error("saveVercelConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("vercel_api_config_response", into: response.data)
            return try JSONDecoder().decode(VercelApiConfigResponseMessage.self, from: patched)
        } catch {
            log.error("saveVercelConfig error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func deleteVercelConfig() async -> VercelApiConfigResponseMessage? {
        do {
            let body: [String: Any] = ["type": "vercel_api_config", "action": "delete"]
            let response = try await GatewayHTTPClient.post(
                path: "integrations/vercel/config", json: body, timeout: 10, unprefixed: true
            )
            guard response.isSuccess else {
                log.error("deleteVercelConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("vercel_api_config_response", into: response.data)
            return try JSONDecoder().decode(VercelApiConfigResponseMessage.self, from: patched)
        } catch {
            log.error("deleteVercelConfig error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func fetchModelInfo() async -> ModelInfoMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "model", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchModelInfo failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("model_info", into: response.data)
            return try JSONDecoder().decode(ModelInfoMessage.self, from: patched)
        } catch {
            log.error("fetchModelInfo error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func setModel(model: String, provider: String? = nil) async -> ModelInfoMessage? {
        do {
            var body: [String: Any] = ["modelId": model]
            if let provider { body["provider"] = provider }
            let response = try await GatewayHTTPClient.put(
                path: "model", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("setModel failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("model_info", into: response.data)
            return try JSONDecoder().decode(ModelInfoMessage.self, from: patched)
        } catch {
            log.error("setModel error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func setImageGenModel(modelId: String) async -> ModelInfoMessage? {
        do {
            let response = try await GatewayHTTPClient.put(
                path: "model/image-gen", json: ["modelId": modelId], timeout: 10
            )
            guard response.isSuccess else {
                log.error("setImageGenModel failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("model_info", into: response.data)
            return try JSONDecoder().decode(ModelInfoMessage.self, from: patched)
        } catch {
            log.error("setImageGenModel error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func fetchEmbeddingConfig() async -> EmbeddingConfigMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/config/embeddings", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchEmbeddingConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(EmbeddingConfigMessage.self, from: response.data)
        } catch {
            log.error("fetchEmbeddingConfig error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func setEmbeddingConfig(provider: String, model: String?) async -> EmbeddingConfigMessage? {
        do {
            var body: [String: Any] = ["provider": provider]
            if let model { body["model"] = model }
            let response = try await GatewayHTTPClient.put(
                path: "assistants/{assistantId}/config/embeddings", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("setEmbeddingConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(EmbeddingConfigMessage.self, from: response.data)
        } catch {
            log.error("setEmbeddingConfig error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func fetchTelegramConfig() async -> TelegramConfigResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/integrations/telegram/config", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchTelegramConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("telegram_config_response", into: response.data)
            return try JSONDecoder().decode(TelegramConfigResponseMessage.self, from: patched)
        } catch {
            log.error("fetchTelegramConfig error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func setTelegramConfig(action: String, botToken: String? = nil, commands: [TelegramConfigRequestCommand]? = nil) async -> TelegramConfigResponseMessage? {
        do {
            var body: [String: Any] = ["type": "telegram_config_request", "action": action]
            if let botToken { body["botToken"] = botToken }
            if let commands {
                let encoded = try JSONEncoder().encode(commands)
                if let arr = try JSONSerialization.jsonObject(with: encoded) as? [[String: Any]] {
                    body["commands"] = arr
                }
            }

            let method = action == "clear" ? "DELETE" : "POST"
            let response: GatewayHTTPClient.Response
            if method == "DELETE" {
                response = try await GatewayHTTPClient.delete(
                    path: "integrations/telegram/config", timeout: 10
                )
            } else {
                response = try await GatewayHTTPClient.post(
                    path: "integrations/telegram/config", json: body, timeout: 10
                )
            }
            guard response.isSuccess else {
                log.error("setTelegramConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("telegram_config_response", into: response.data)
            return try JSONDecoder().decode(TelegramConfigResponseMessage.self, from: patched)
        } catch {
            log.error("setTelegramConfig error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func setSlackWebhookConfig(action: String, webhookUrl: String? = nil) async -> Bool {
        do {
            var body: [String: Any] = ["type": "slack_webhook_config", "action": action]
            if let webhookUrl { body["webhookUrl"] = webhookUrl }

            let response = try await GatewayHTTPClient.post(
                path: "integrations/slack/config", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("setSlackWebhookConfig failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("setSlackWebhookConfig error: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    public func fetchChannelVerificationStatus(channel: String) async -> ChannelVerificationSessionResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "channel-verification-sessions/status",
                params: ["channel": channel],
                timeout: 10,
                unprefixed: true
            )
            guard response.isSuccess else {
                log.error("fetchChannelVerificationStatus(\(channel, privacy: .public)) failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("channel_verification_session_response", into: response.data)
            return try JSONDecoder().decode(ChannelVerificationSessionResponseMessage.self, from: patched)
        } catch {
            log.error("fetchChannelVerificationStatus(\(channel, privacy: .public)) error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func sendChannelVerificationSession(
        action: String,
        channel: String? = nil,
        conversationId: String? = nil,
        rebind: Bool? = nil,
        destination: String? = nil,
        originConversationId: String? = nil,
        purpose: String? = nil,
        contactChannelId: String? = nil
    ) async -> ChannelVerificationSessionResponseMessage? {
        do {
            var body: [String: Any] = ["action": action]
            if let channel { body["channel"] = channel }
            if let conversationId { body["conversationId"] = conversationId }
            if let rebind { body["rebind"] = rebind }
            if let destination { body["destination"] = destination }
            if let originConversationId { body["originConversationId"] = originConversationId }
            if let purpose { body["purpose"] = purpose }
            if let contactChannelId { body["contactChannelId"] = contactChannelId }

            let response: GatewayHTTPClient.Response
            switch action {
            case "cancel_session":
                response = try await GatewayHTTPClient.delete(
                    path: "channel-verification-sessions", json: body, timeout: 10
                )
            case "revoke":
                response = try await GatewayHTTPClient.post(
                    path: "channel-verification-sessions/revoke", json: body, timeout: 10
                )
            case "resend_session":
                response = try await GatewayHTTPClient.post(
                    path: "channel-verification-sessions/resend", json: body, timeout: 10
                )
            default:
                response = try await GatewayHTTPClient.post(
                    path: "channel-verification-sessions", json: body, timeout: 10
                )
            }

            guard response.isSuccess else {
                log.error("sendChannelVerificationSession(\(action, privacy: .public), \(channel ?? "nil", privacy: .public)) failed (HTTP \(response.statusCode))")
                return decodeErrorResponse(from: response.data, channel: channel)
            }
            let patched = injectType("channel_verification_session_response", into: response.data)
            return try JSONDecoder().decode(ChannelVerificationSessionResponseMessage.self, from: patched)
        } catch {
            log.error("sendChannelVerificationSession(\(action, privacy: .public)) error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Decode an error response body into a failed ``ChannelVerificationSessionResponseMessage``
    /// so callers can display the server-provided error message.
    private func decodeErrorResponse(from data: Data, channel: String?) -> ChannelVerificationSessionResponseMessage? {
        var errorMessage = "Request failed"
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let error = json["error"] as? [String: Any],
               let message = error["message"] as? String {
                errorMessage = message
            } else if let message = json["error"] as? String {
                errorMessage = message
            }
        }
        var syntheticJSON: [String: Any] = [
            "type": "channel_verification_session_response",
            "success": false,
            "error": errorMessage,
        ]
        if let channel { syntheticJSON["channel"] = channel }
        guard let syntheticData = try? JSONSerialization.data(withJSONObject: syntheticJSON) else { return nil }
        return try? JSONDecoder().decode(ChannelVerificationSessionResponseMessage.self, from: syntheticData)
    }

    // MARK: - Voice, OAuth, Device Token, Ingress, Suggestion

    public func updateVoiceConfig(_ config: VoiceConfigUpdateRequest) async -> Bool {
        do {
            let body = try JSONEncoder().encode(config)
            let response = try await GatewayHTTPClient.put(
                path: "settings/voice",
                body: body,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("updateVoiceConfig failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("updateVoiceConfig error: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    public func startOAuthConnect(_ request: OAuthConnectStartRequest) async -> Bool {
        do {
            let body = try JSONEncoder().encode(request)
            let response = try await GatewayHTTPClient.post(
                path: "oauth/start",
                body: body,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("startOAuthConnect failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("startOAuthConnect error: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    public func registerDeviceToken(token: String, platform: String) async -> Bool {
        do {
            let body: [String: Any] = [
                "type": "register_device_token",
                "token": token,
                "platform": platform
            ]
            let response = try await GatewayHTTPClient.post(
                path: "device-token",
                json: body,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("registerDeviceToken failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("registerDeviceToken error: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    public func fetchIngressConfig() async -> IngressConfigResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "integrations/ingress/config",
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchIngressConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("ingress_config_response", into: response.data)
            return try JSONDecoder().decode(IngressConfigResponseMessage.self, from: patched)
        } catch {
            log.error("fetchIngressConfig error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func updateIngressConfig(publicBaseUrl: String?, enabled: Bool?) async -> IngressConfigResponseMessage? {
        do {
            var body: [String: Any] = ["action": "set"]
            if let publicBaseUrl { body["publicBaseUrl"] = publicBaseUrl }
            if let enabled { body["enabled"] = enabled }
            let response = try await GatewayHTTPClient.put(
                path: "integrations/ingress/config",
                json: body,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("updateIngressConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("ingress_config_response", into: response.data)
            return try JSONDecoder().decode(IngressConfigResponseMessage.self, from: patched)
        } catch {
            log.error("updateIngressConfig error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func fetchSuggestion(conversationId: String, requestId: String) async -> SuggestionResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "suggestion",
                params: ["conversationKey": conversationId],
                timeout: 15
            )
            guard response.isSuccess else {
                log.error("fetchSuggestion failed (HTTP \(response.statusCode))")
                return nil
            }
            var json = (try? JSONSerialization.jsonObject(with: response.data) as? [String: Any]) ?? [:]
            json["type"] = "suggestion_response"
            json["requestId"] = requestId
            let enriched = try JSONSerialization.data(withJSONObject: json)
            return try JSONDecoder().decode(SuggestionResponseMessage.self, from: enriched)
        } catch {
            log.error("fetchSuggestion error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    // MARK: - Platform Config

    public func fetchPlatformConfig() async -> PlatformConfigResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "config/platform", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchPlatformConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("platform_config_response", into: response.data)
            return try JSONDecoder().decode(PlatformConfigResponseMessage.self, from: patched)
        } catch {
            log.error("fetchPlatformConfig error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func setPlatformConfig(baseUrl: String) async -> PlatformConfigResponseMessage? {
        do {
            let body: [String: Any] = ["baseUrl": baseUrl]
            let response = try await GatewayHTTPClient.put(
                path: "config/platform", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("setPlatformConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("platform_config_response", into: response.data)
            return try JSONDecoder().decode(PlatformConfigResponseMessage.self, from: patched)
        } catch {
            log.error("setPlatformConfig error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func patchConfig(_ partial: [String: Any]) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.patch(
                path: "config", json: partial, timeout: 10
            )
            guard response.isSuccess else {
                log.error("patchConfig failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("patchConfig error: \(error.localizedDescription)")
            return false
        }
    }

    public func replaceInferenceProfile(name: String, fragment: [String: Any]) async -> Bool {
        do {
            let encodedName = Self.encodePath(name)
            let response = try await GatewayHTTPClient.put(
                path: "config/llm/profiles/\(encodedName)",
                json: fragment,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("replaceInferenceProfile failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("replaceInferenceProfile error: \(error.localizedDescription)")
            return false
        }
    }

    public func fetchConfig() async -> [String: Any]? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "config", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            guard let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any] else {
                return nil
            }
            return json
        } catch {
            log.error("fetchConfig error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Checks whether the credential store contains an API key for the given
    /// provider by querying the assistant-scoped `secrets/read` endpoint.
    public func checkApiKeyExists(provider: String) async -> Bool {
        do {
            let body: [String: Any] = ["type": "api_key", "name": provider]
            let response = try await GatewayHTTPClient.post(
                path: "secrets/read", json: body, timeout: 5
            )
            guard response.isSuccess,
                  let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                  let found = json["found"] as? Bool else {
                return false
            }
            return found
        } catch {
            log.error("checkApiKeyExists error: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    // MARK: - Call Site Catalog

    public func fetchCallSiteCatalog() async -> CallSiteCatalogResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "config/llm/call-sites", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchCallSiteCatalog failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(CallSiteCatalogResponse.self, from: response.data)
        } catch {
            log.error("fetchCallSiteCatalog error: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    // MARK: - Helpers

    /// Injects the `"type"` discriminant required by `Codable` decoding of
    /// server message types whose JSON payloads omit it over HTTP.
    private func injectType(_ type: String, into data: Data) -> Data {
        guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return data
        }
        json["type"] = type
        return (try? JSONSerialization.data(withJSONObject: json)) ?? data
    }

}

// MARK: - Embedding Config Types

public struct EmbeddingProviderOption: Codable {
    public let id: String
    public let displayName: String
    public let defaultModel: String
    public let requiresKey: Bool
}

public struct EmbeddingStatusInfo: Codable {
    public let enabled: Bool
    public let degraded: Bool
    public let reason: String?
}

public struct EmbeddingConfigMessage: Codable {
    public let provider: String
    public let model: String?
    public let activeProvider: String?
    public let activeModel: String?
    public let availableProviders: [EmbeddingProviderOption]?
    public let status: EmbeddingStatusInfo?
}
// MARK: - Call Site Catalog Types

public struct CallSiteCatalogDomain: Codable {
    public let id: String
    public let displayName: String

    public init(id: String, displayName: String) {
        self.id = id
        self.displayName = displayName
    }
}

public struct CallSiteCatalogEntry: Codable {
    public let id: String
    public let displayName: String
    public let description: String
    public let domain: String

    public init(id: String, displayName: String, description: String, domain: String) {
        self.id = id
        self.displayName = displayName
        self.description = description
        self.domain = domain
    }
}

public struct CallSiteCatalogResponse: Codable {
    public let domains: [CallSiteCatalogDomain]
    public let callSites: [CallSiteCatalogEntry]

    public init(domains: [CallSiteCatalogDomain], callSites: [CallSiteCatalogEntry]) {
        self.domains = domains
        self.callSites = callSites
    }
}
