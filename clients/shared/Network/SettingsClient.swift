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
    func setModel(model: String, provider: String?) async -> ModelInfoMessage?
    func setImageGenModel(modelId: String) async -> ModelInfoMessage?
    func fetchTelegramConfig() async -> TelegramConfigResponseMessage?
    func setTelegramConfig(action: String, botToken: String?, commands: [TelegramConfigRequestCommand]?) async -> TelegramConfigResponseMessage?
    func setSlackWebhookConfig(action: String, webhookUrl: String?) async -> Bool
    func fetchChannelVerificationStatus(channel: String) async -> ChannelVerificationSessionResponseMessage?
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
