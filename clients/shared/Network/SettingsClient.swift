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
    func fetchTelegramConfig() async -> TelegramConfigResponseMessage?
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
