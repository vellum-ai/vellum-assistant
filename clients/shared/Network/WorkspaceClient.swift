import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "WorkspaceClient")

/// Focused client for workspace file-system operations routed through the gateway.
@MainActor
public protocol WorkspaceClientProtocol {
    func fetchWorkspaceTree(path: String, showHidden: Bool) async -> WorkspaceTreeResponse?
    func fetchWorkspaceFile(path: String, showHidden: Bool) async -> WorkspaceFileResponse?
    func deleteWorkspaceItem(path: String) async -> Bool
}

/// Gateway-backed implementation of ``WorkspaceClientProtocol``.
@MainActor
public struct WorkspaceClient: WorkspaceClientProtocol {
    nonisolated public init() {}

    public func fetchWorkspaceTree(path: String, showHidden: Bool) async -> WorkspaceTreeResponse? {
        var params: [String: String] = [:]
        if !path.isEmpty { params["path"] = path }
        if showHidden { params["showHidden"] = "true" }

        let response = try? await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/workspace/tree", params: params, timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Fetch workspace tree failed (HTTP \(statusCode))")
            return nil
        }
        guard let data = response?.data else { return nil }
        return try? JSONDecoder().decode(WorkspaceTreeResponse.self, from: data)
    }

    public func fetchWorkspaceFile(path: String, showHidden: Bool) async -> WorkspaceFileResponse? {
        var params: [String: String] = ["path": path]
        if showHidden { params["showHidden"] = "true" }

        let response = try? await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/workspace/file", params: params, timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Fetch workspace file failed (HTTP \(statusCode))")
            return nil
        }
        guard let data = response?.data else { return nil }
        return try? JSONDecoder().decode(WorkspaceFileResponse.self, from: data)
    }

    public func deleteWorkspaceItem(path: String) async -> Bool {
        let response = try? await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/workspace/delete", json: ["path": path], timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Delete workspace item failed (HTTP \(statusCode))")
            return false
        }
        return response?.isSuccess ?? false
    }
}
