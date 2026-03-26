import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ToolClient")

/// Focused client for tool-related operations routed through the gateway.
public protocol ToolClientProtocol {
    func fetchToolNamesList() async throws -> ToolNamesListResponseMessage
    func simulateToolPermission(
        toolName: String,
        input: [String: AnyCodable],
        workingDir: String?,
        isInteractive: Bool?,
        forcePromptSideEffects: Bool?
    ) async throws -> ToolPermissionSimulateResponseMessage
}

/// Gateway-backed implementation of ``ToolClientProtocol``.
public struct ToolClient: ToolClientProtocol {
    nonisolated public init() {}

    enum ToolClientError: LocalizedError {
        case httpError(statusCode: Int)

        var errorDescription: String? {
            switch self {
            case .httpError(let statusCode):
                return "Tool request failed (HTTP \(statusCode))"
            }
        }
    }

    public func fetchToolNamesList() async throws -> ToolNamesListResponseMessage {
        let response = try await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/tools", timeout: 10
        )
        guard response.isSuccess else {
            log.error("fetchToolNamesList failed (HTTP \(response.statusCode))")
            throw ToolClientError.httpError(statusCode: response.statusCode)
        }
        let patched = injectType("tool_names_list_response", into: response.data)
        return try JSONDecoder().decode(ToolNamesListResponseMessage.self, from: patched)
    }

    public func simulateToolPermission(
        toolName: String,
        input: [String: AnyCodable],
        workingDir: String? = nil,
        isInteractive: Bool? = nil,
        forcePromptSideEffects: Bool? = nil
    ) async throws -> ToolPermissionSimulateResponseMessage {
        var body: [String: Any] = [
            "toolName": toolName,
        ]

        // Encode AnyCodable input into a plain dictionary for JSONSerialization.
        var inputDict: [String: Any] = [:]
        for (key, value) in input {
            inputDict[key] = value.value
        }
        body["input"] = inputDict

        if let workingDir { body["workingDir"] = workingDir }
        if let isInteractive { body["isInteractive"] = isInteractive }
        if let forcePromptSideEffects { body["forcePromptSideEffects"] = forcePromptSideEffects }

        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/tools/simulate-permission", json: body, timeout: 10
        )
        guard response.isSuccess else {
            log.error("simulateToolPermission failed (HTTP \(response.statusCode))")
            throw ToolClientError.httpError(statusCode: response.statusCode)
        }
        let patched = injectType("tool_permission_simulate_response", into: response.data)
        return try JSONDecoder().decode(ToolPermissionSimulateResponseMessage.self, from: patched)
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
