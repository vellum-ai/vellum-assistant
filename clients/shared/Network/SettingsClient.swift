import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "SettingsClient")

/// Focused client for settings-related operations routed through the gateway.
///
/// Covers Vercel API config, model info, Telegram config, and channel
/// verification status — the endpoints invoked during `SettingsStore.init()`.
@MainActor
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
}

/// Gateway-backed implementation of ``SettingsClientProtocol``.
@MainActor
public struct SettingsClient: SettingsClientProtocol {
    nonisolated public init() {}

    public func fetchVercelConfig() async -> VercelApiConfigResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "integrations/vercel/config", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchVercelConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("vercel_api_config_response", into: response.data)
            return try JSONDecoder().decode(VercelApiConfigResponseMessage.self, from: patched)
        } catch {
            log.error("fetchVercelConfig error: \(error.localizedDescription)")
            return nil
        }
    }

    public func saveVercelConfig(apiToken: String) async -> VercelApiConfigResponseMessage? {
        do {
            let body: [String: Any] = ["type": "vercel_api_config", "action": "set", "apiToken": apiToken]
            let response = try await GatewayHTTPClient.post(
                path: "integrations/vercel/config", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("saveVercelConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("vercel_api_config_response", into: response.data)
            return try JSONDecoder().decode(VercelApiConfigResponseMessage.self, from: patched)
        } catch {
            log.error("saveVercelConfig error: \(error.localizedDescription)")
            return nil
        }
    }

    public func deleteVercelConfig() async -> VercelApiConfigResponseMessage? {
        do {
            let body: [String: Any] = ["type": "vercel_api_config", "action": "delete"]
            let response = try await GatewayHTTPClient.post(
                path: "integrations/vercel/config", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("deleteVercelConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("vercel_api_config_response", into: response.data)
            return try JSONDecoder().decode(VercelApiConfigResponseMessage.self, from: patched)
        } catch {
            log.error("deleteVercelConfig error: \(error.localizedDescription)")
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
            log.error("fetchModelInfo error: \(error.localizedDescription)")
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
            log.error("setModel error: \(error.localizedDescription)")
            return nil
        }
    }

    public func setImageGenModel(modelId: String) async -> ModelInfoMessage? {
        do {
            let response = try await GatewayHTTPClient.put(
                path: "assistants/{assistantId}/model/image-gen", json: ["modelId": modelId], timeout: 10
            )
            guard response.isSuccess else {
                log.error("setImageGenModel failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("model_info", into: response.data)
            return try JSONDecoder().decode(ModelInfoMessage.self, from: patched)
        } catch {
            log.error("setImageGenModel error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchEmbeddingConfig() async -> EmbeddingConfigMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "config/embeddings", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchEmbeddingConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(EmbeddingConfigMessage.self, from: response.data)
        } catch {
            log.error("fetchEmbeddingConfig error: \(error.localizedDescription)")
            return nil
        }
    }

    public func setEmbeddingConfig(provider: String, model: String?) async -> EmbeddingConfigMessage? {
        do {
            var body: [String: Any] = ["provider": provider]
            if let model { body["model"] = model }
            let response = try await GatewayHTTPClient.put(
                path: "config/embeddings", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("setEmbeddingConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(EmbeddingConfigMessage.self, from: response.data)
        } catch {
            log.error("setEmbeddingConfig error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchTelegramConfig() async -> TelegramConfigResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "integrations/telegram/config", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchTelegramConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("telegram_config_response", into: response.data)
            return try JSONDecoder().decode(TelegramConfigResponseMessage.self, from: patched)
        } catch {
            log.error("fetchTelegramConfig error: \(error.localizedDescription)")
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
                    path: "assistants/{assistantId}/integrations/telegram/config", timeout: 10
                )
            } else {
                response = try await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/integrations/telegram/config", json: body, timeout: 10
                )
            }
            guard response.isSuccess else {
                log.error("setTelegramConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("telegram_config_response", into: response.data)
            return try JSONDecoder().decode(TelegramConfigResponseMessage.self, from: patched)
        } catch {
            log.error("setTelegramConfig error: \(error.localizedDescription)")
            return nil
        }
    }

    public func setSlackWebhookConfig(action: String, webhookUrl: String? = nil) async -> Bool {
        do {
            var body: [String: Any] = ["type": "slack_webhook_config", "action": action]
            if let webhookUrl { body["webhookUrl"] = webhookUrl }

            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/integrations/slack/config", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("setSlackWebhookConfig failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("setSlackWebhookConfig error: \(error.localizedDescription)")
            return false
        }
    }

    public func fetchChannelVerificationStatus(channel: String) async -> ChannelVerificationSessionResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "channel-verification-sessions/status",
                params: ["channel": channel],
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchChannelVerificationStatus(\(channel)) failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("channel_verification_session_response", into: response.data)
            return try JSONDecoder().decode(ChannelVerificationSessionResponseMessage.self, from: patched)
        } catch {
            log.error("fetchChannelVerificationStatus(\(channel)) error: \(error.localizedDescription)")
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
                    path: "assistants/{assistantId}/channel-verification-sessions", json: body, timeout: 10
                )
            case "revoke":
                response = try await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/channel-verification-sessions/revoke", json: body, timeout: 10
                )
            case "resend_session":
                response = try await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/channel-verification-sessions/resend", json: body, timeout: 10
                )
            default:
                response = try await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/channel-verification-sessions", json: body, timeout: 10
                )
            }

            guard response.isSuccess else {
                log.error("sendChannelVerificationSession(\(action), \(channel ?? "nil")) failed (HTTP \(response.statusCode))")
                return decodeErrorResponse(from: response.data, channel: channel)
            }
            let patched = injectType("channel_verification_session_response", into: response.data)
            return try JSONDecoder().decode(ChannelVerificationSessionResponseMessage.self, from: patched)
        } catch {
            log.error("sendChannelVerificationSession(\(action)) error: \(error.localizedDescription)")
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
