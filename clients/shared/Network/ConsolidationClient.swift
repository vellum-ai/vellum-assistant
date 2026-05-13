import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ConsolidationClient")

/// Focused client for memory v2 consolidation operations routed through the gateway.
///
/// Mirrors ``FilingClientProtocol`` — consolidation replaces filing as the
/// active background memory job when `memory.v2.enabled` is true.
public protocol ConsolidationClientProtocol {
    func fetchConfig() async -> ConsolidationConfigResponse?
    func runNow() async -> ConsolidationRunNowResponse?
}

/// Gateway-backed implementation of ``ConsolidationClientProtocol``.
public struct ConsolidationClient: ConsolidationClientProtocol {
    nonisolated public init() {}

    public func fetchConfig() async -> ConsolidationConfigResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "consolidation/config", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("consolidation_config_response", into: response.data)
            return try JSONDecoder().decode(ConsolidationConfigResponse.self, from: patched)
        } catch {
            log.error("fetchConfig error: \(error.localizedDescription)")
            return nil
        }
    }

    public func runNow() async -> ConsolidationRunNowResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "consolidation/run-now", timeout: 30
            )
            guard response.isSuccess else {
                log.error("runNow failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("consolidation_run_now_response", into: response.data)
            return try JSONDecoder().decode(ConsolidationRunNowResponse.self, from: patched)
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
