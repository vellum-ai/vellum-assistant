import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "WorkspaceClient")

/// Focused client for workspace file-system operations routed through the gateway.
public protocol WorkspaceClientProtocol {
    func fetchWorkspaceTree(path: String, showHidden: Bool) async -> WorkspaceTreeResponse?
    func fetchWorkspaceFile(path: String, showHidden: Bool) async -> WorkspaceFileResponse?
    func fetchWorkspaceFilesList() async -> WorkspaceFilesListResponse?
    func deleteWorkspaceItem(path: String) async -> Bool
    func writeWorkspaceFile(path: String, content: Data) async -> Bool
    func createWorkspaceDirectory(path: String) async -> Bool
    func renameWorkspaceItem(oldPath: String, newPath: String) async -> Bool
    func fetchWorkspaceFileContent(path: String, showHidden: Bool) async throws -> Data
    func downloadWorkspaceFileContent(path: String, showHidden: Bool) async throws -> URL
}

/// Gateway-backed implementation of ``WorkspaceClientProtocol``.
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

    /// Fetches the server-curated list of well-known workspace files via
    /// `GET /workspace-files`. Unlike ``fetchWorkspaceTree``, this endpoint
    /// returns a flat list that the daemon builds dynamically — including
    /// the guardian's per-user persona file at `users/<slug>.md` when
    /// present — so the UI doesn't need to hardcode which files to look for.
    public func fetchWorkspaceFilesList() async -> WorkspaceFilesListResponse? {
        let response = try? await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/workspace-files", timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Fetch workspace files list failed (HTTP \(statusCode))")
            return nil
        }
        guard let data = response?.data else { return nil }
        return try? JSONDecoder().decode(WorkspaceFilesListResponse.self, from: data)
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

    public func writeWorkspaceFile(path: String, content: Data) async -> Bool {
        var body: [String: Any] = ["path": path]
        if let text = String(data: content, encoding: .utf8), !content.isEmpty {
            body["content"] = text
        } else {
            body["content"] = content.base64EncodedString()
            body["encoding"] = "base64"
        }

        let response = try? await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/workspace/write", json: body, timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Write workspace file failed (HTTP \(statusCode))")
            return false
        }
        return response?.isSuccess ?? false
    }

    public func createWorkspaceDirectory(path: String) async -> Bool {
        let response = try? await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/workspace/mkdir", json: ["path": path], timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Create workspace directory failed (HTTP \(statusCode))")
            return false
        }
        return response?.isSuccess ?? false
    }

    public func renameWorkspaceItem(oldPath: String, newPath: String) async -> Bool {
        let response = try? await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/workspace/rename", json: ["oldPath": oldPath, "newPath": newPath], timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Rename workspace item failed (HTTP \(statusCode))")
            return false
        }
        return response?.isSuccess ?? false
    }

    /// Fetches the raw binary content for a workspace file via the gateway.
    ///
    /// Routes through ``GatewayHTTPClient`` so managed assistants use the
    /// platform proxy with session-token auth while local assistants hit
    /// the local gateway with bearer-token auth.
    public func fetchWorkspaceFileContent(path: String, showHidden: Bool) async throws -> Data {
        var params: [String: String] = ["path": path]
        if showHidden { params["showHidden"] = "true" }
        let response = try await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/workspace/file/content", params: params, timeout: 120
        )
        guard response.isSuccess else {
            log.error("Workspace file content fetch failed (HTTP \(response.statusCode)) for \(path)")
            throw URLError(.badServerResponse)
        }
        return response.data
    }

    /// Downloads a workspace file directly to a temporary file on disk via the gateway,
    /// avoiding buffering the entire payload in memory.
    ///
    /// Use this for large binary files (e.g. videos) where in-memory buffering
    /// would cause memory pressure.
    public func downloadWorkspaceFileContent(path: String, showHidden: Bool) async throws -> URL {
        var params: [String: String] = ["path": path]
        if showHidden { params["showHidden"] = "true" }
        let response = try await GatewayHTTPClient.download(
            path: "assistants/{assistantId}/workspace/file/content", params: params, timeout: 120
        )
        guard response.isSuccess else {
            try? FileManager.default.removeItem(at: response.fileURL)
            log.error("Workspace file download failed (HTTP \(response.statusCode)) for \(path)")
            throw URLError(.badServerResponse)
        }
        return response.fileURL
    }
}
