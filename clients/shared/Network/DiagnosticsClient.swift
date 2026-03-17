import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DiagnosticsClient")

/// Focused client for diagnostics operations routed through the gateway.
@MainActor
public protocol DiagnosticsClientProtocol {
    func exportDiagnostics(conversationId: String, anchorMessageId: String?) async -> DiagnosticsExportResponseMessage?
    func fetchEnvVars() async -> EnvVarsResponseMessage?
}

/// Gateway-backed implementation of ``DiagnosticsClientProtocol``.
@MainActor
public struct DiagnosticsClient: DiagnosticsClientProtocol {
    nonisolated public init() {}

    public func exportDiagnostics(conversationId: String, anchorMessageId: String? = nil) async -> DiagnosticsExportResponseMessage? {
        do {
            var body: [String: Any] = ["conversationId": conversationId]
            if let anchorMessageId { body["anchorMessageId"] = anchorMessageId }

            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/diagnostics/export", json: body, timeout: 30
            )
            guard response.isSuccess else {
                log.error("exportDiagnostics failed (HTTP \(response.statusCode))")
                return DiagnosticsExportResponseMessage(
                    success: false,
                    filePath: nil,
                    error: "HTTP \(response.statusCode)"
                )
            }
            return try JSONDecoder().decode(DiagnosticsExportResponseMessage.self, from: response.data)
        } catch {
            log.error("exportDiagnostics error: \(error.localizedDescription)")
            return DiagnosticsExportResponseMessage(
                success: false,
                filePath: nil,
                error: error.localizedDescription
            )
        }
    }

    public func fetchEnvVars() async -> EnvVarsResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/diagnostics/env-vars", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchEnvVars failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("env_vars_response", into: response.data)
            return try JSONDecoder().decode(EnvVarsResponseMessage.self, from: patched)
        } catch {
            log.error("fetchEnvVars error: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Helpers

    private func injectType(_ type: String, into data: Data) -> Data {
        guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return data
        }
        json["type"] = type
        return (try? JSONSerialization.data(withJSONObject: json)) ?? data
    }
}
