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
    func fetchModelInfo() async -> ModelInfoMessage?
    func setModel(model: String) async -> ModelInfoMessage?
    func setImageGenModel(modelId: String) async -> ModelInfoMessage?
    func fetchTelegramConfig() async -> TelegramConfigResponseMessage?
    func setTelegramConfig(action: String, botToken: String?, commands: [TelegramConfigRequestCommand]?) async -> TelegramConfigResponseMessage?
    func setSlackWebhookConfig(action: String, webhookUrl: String?) async -> Bool
    func fetchChannelVerificationStatus(channel: String) async -> ChannelVerificationSessionResponseMessage?
    func saveVercelConfig(action: String, apiToken: String?) async -> VercelApiConfigResponseMessage?
    func sendChannelVerificationSession(action: String, channel: String?, conversationId: String?, rebind: Bool?, destination: String?, originConversationId: String?, purpose: String?, contactChannelId: String?) async -> ChannelVerificationSessionResponseMessage?
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

    public func setModel(model: String) async -> ModelInfoMessage? {
        do {
            let response = try await GatewayHTTPClient.put(
                path: "model", json: ["modelId": model], timeout: 10
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

    public func saveVercelConfig(action: String, apiToken: String? = nil) async -> VercelApiConfigResponseMessage? {
        do {
            var body: [String: Any] = ["action": action]
            if let apiToken { body["apiToken"] = apiToken }

            let response: GatewayHTTPClient.Response
            if action == "delete" {
                response = try await GatewayHTTPClient.delete(
                    path: "integrations/vercel/config", timeout: 10
                )
            } else {
                response = try await GatewayHTTPClient.post(
                    path: "integrations/vercel/config", json: body, timeout: 10
                )
            }
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
            case "resend_session":
                response = try await GatewayHTTPClient.post(
                    path: "channel-verification-sessions/resend", json: body, timeout: 10
                )
            case "revoke":
                response = try await GatewayHTTPClient.post(
                    path: "channel-verification-sessions/revoke", json: body, timeout: 10
                )
            default:
                response = try await GatewayHTTPClient.post(
                    path: "channel-verification-sessions", json: body, timeout: 10
                )
            }
            guard response.isSuccess else {
                log.error("sendChannelVerificationSession failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("channel_verification_session_response", into: response.data)
            return try JSONDecoder().decode(ChannelVerificationSessionResponseMessage.self, from: patched)
        } catch {
            log.error("sendChannelVerificationSession error: \(error.localizedDescription)")
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
