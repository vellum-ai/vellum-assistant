import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "WorkspaceClient")

/// Focused client for workspace file-system operations routed through the gateway.
@MainActor
protocol WorkspaceClientProtocol {
    func fetchWorkspaceTree(path: String, showHidden: Bool) async -> WorkspaceTreeResponse?
}

/// Gateway-backed implementation of ``WorkspaceClientProtocol``.
@MainActor
struct WorkspaceClient: WorkspaceClientProtocol {
    nonisolated init() {}

    /// A restricted character set for encoding query parameter values.
    /// `.urlQueryAllowed` permits `&`, `=`, `+`, and `#` which are
    /// query-string metacharacters. File paths containing these characters
    /// would break parameter parsing, so we exclude them.
    private static let queryValueAllowed: CharacterSet = {
        var cs = CharacterSet.urlQueryAllowed
        cs.remove(charactersIn: "&=+#")
        return cs
    }()

    func fetchWorkspaceTree(path: String, showHidden: Bool) async -> WorkspaceTreeResponse? {
        let encoded = path.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) ?? path
        var params: [String] = []
        if !path.isEmpty { params.append("path=\(encoded)") }
        if showHidden { params.append("showHidden=true") }
        let query = params.isEmpty ? "" : "?\(params.joined(separator: "&"))"

        let response = try? await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/workspace/tree\(query)", timeout: 10
        )
        if let statusCode = response?.statusCode, !(200..<300).contains(statusCode) {
            log.error("Fetch workspace tree failed (HTTP \(statusCode))")
            return nil
        }
        guard let data = response?.data else { return nil }
        return try? JSONDecoder().decode(WorkspaceTreeResponse.self, from: data)
    }
}
