import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HeartbeatClient")

/// Focused client for heartbeat-related operations routed through the gateway.
///
/// Covers heartbeat configuration, run history, on-demand runs, and checklist
/// management.
public protocol HeartbeatClientProtocol {
    func fetchConfig() async -> HeartbeatConfigResponse?
    func updateConfig(enabled: Bool?, intervalMs: Double?, activeHoursStart: Double?, activeHoursEnd: Double?) async -> HeartbeatConfigResponse?
    func fetchRunsList(limit: Int?) async -> HeartbeatRunsListResponse?
    func runNow() async -> HeartbeatRunNowResponse?
    func fetchChecklist() async -> HeartbeatChecklistResponse?
    func writeChecklist(content: String) async -> HeartbeatChecklistWriteResponse?
}

/// Gateway-backed implementation of ``HeartbeatClientProtocol``.
public struct HeartbeatClient: HeartbeatClientProtocol {
    nonisolated public init() {}

    public func fetchConfig() async -> HeartbeatConfigResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/heartbeat/config", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("heartbeat_config_response", into: response.data)
            return try JSONDecoder().decode(HeartbeatConfigResponse.self, from: patched)
        } catch {
            log.error("fetchConfig error: \(error.localizedDescription)")
            return nil
        }
    }

    public func updateConfig(enabled: Bool? = nil, intervalMs: Double? = nil, activeHoursStart: Double? = nil, activeHoursEnd: Double? = nil) async -> HeartbeatConfigResponse? {
        do {
            var body: [String: Any] = [:]
            if let enabled { body["enabled"] = enabled }
            if let intervalMs { body["intervalMs"] = intervalMs }
            if let activeHoursStart { body["activeHoursStart"] = activeHoursStart }
            if let activeHoursEnd { body["activeHoursEnd"] = activeHoursEnd }

            let response = try await GatewayHTTPClient.put(
                path: "assistants/{assistantId}/heartbeat/config", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("updateConfig failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("heartbeat_config_response", into: response.data)
            return try JSONDecoder().decode(HeartbeatConfigResponse.self, from: patched)
        } catch {
            log.error("updateConfig error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchRunsList(limit: Int? = nil) async -> HeartbeatRunsListResponse? {
        do {
            var params: [String: String] = [:]
            if let limit { params["limit"] = String(limit) }

            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/heartbeat/runs",
                params: params.isEmpty ? nil : params,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchRunsList failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("heartbeat_runs_list_response", into: response.data)
            return try JSONDecoder().decode(HeartbeatRunsListResponse.self, from: patched)
        } catch {
            log.error("fetchRunsList error: \(error.localizedDescription)")
            return nil
        }
    }

    public func runNow() async -> HeartbeatRunNowResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/heartbeat/run-now", timeout: 10
            )
            guard response.isSuccess else {
                log.error("runNow failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("heartbeat_run_now_response", into: response.data)
            return try JSONDecoder().decode(HeartbeatRunNowResponse.self, from: patched)
        } catch {
            log.error("runNow error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchChecklist() async -> HeartbeatChecklistResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/heartbeat/checklist", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchChecklist failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("heartbeat_checklist_response", into: response.data)
            return try JSONDecoder().decode(HeartbeatChecklistResponse.self, from: patched)
        } catch {
            log.error("fetchChecklist error: \(error.localizedDescription)")
            return nil
        }
    }

    public func writeChecklist(content: String) async -> HeartbeatChecklistWriteResponse? {
        do {
            let body: [String: Any] = ["content": content]
            let response = try await GatewayHTTPClient.put(
                path: "assistants/{assistantId}/heartbeat/checklist", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("writeChecklist failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("heartbeat_checklist_write_response", into: response.data)
            return try JSONDecoder().decode(HeartbeatChecklistWriteResponse.self, from: patched)
        } catch {
            log.error("writeChecklist error: \(error.localizedDescription)")
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
