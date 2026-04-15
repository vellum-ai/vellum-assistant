import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "FilingClient")

/// Focused client for filing-related operations routed through the gateway.
///
/// Covers filing configuration reads and on-demand runs.
public protocol FilingClientProtocol {
    func fetchConfig() async -> FilingConfigResponse?
    func runNow() async -> FilingRunNowResponse?
}

/// Gateway-backed implementation of ``FilingClientProtocol``.
public struct FilingClient: FilingClientProtocol {
    nonisolated public init() {}

    public func fetchConfig() async -> FilingConfigResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/filing/config", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("filing_config_response", into: response.data)
            return try JSONDecoder().decode(FilingConfigResponse.self, from: patched)
        } catch {
            log.error("fetchConfig error: \(error.localizedDescription)")
            return nil
        }
    }

    public func runNow() async -> FilingRunNowResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/filing/run-now", timeout: 120
            )
            guard response.isSuccess else {
                log.error("runNow failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("filing_run_now_response", into: response.data)
            return try JSONDecoder().decode(FilingRunNowResponse.self, from: patched)
        } catch {
            log.error("runNow error: \(error.localizedDescription)")
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
