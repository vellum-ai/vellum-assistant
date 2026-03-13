import Foundation
import VellumAssistantShared

/// Authenticated HTTP client for platform assistant proxy requests.
///
/// All managed/remote assistant operations route through the platform at
/// `{baseURL}/v1/assistants/...` with session-token authentication.
/// This client consolidates URL construction, auth headers, org-id
/// injection, and request execution so callers can simply write:
///
///     let response = try await GatewayHTTPClient.get(path: "\(id)/healthz")
///     let response = try await GatewayHTTPClient.post(path: "upgrade")
@MainActor
enum GatewayHTTPClient {

    /// Response from a gateway HTTP request.
    struct Response {
        let data: Data
        let statusCode: Int

        var isSuccess: Bool { (200..<300).contains(statusCode) }
    }

    /// Errors specific to gateway request construction.
    enum ClientError: LocalizedError {
        case noConnectedAssistant
        case notAuthenticated
        case invalidURL

        var errorDescription: String? {
            switch self {
            case .noConnectedAssistant: return "No connected assistant"
            case .notAuthenticated: return "Not authenticated"
            case .invalidURL: return "Invalid request URL"
            }
        }
    }

    // MARK: - High-Level API

    /// Performs an authenticated GET request against the platform assistant proxy.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/assistants/` (e.g. `"{id}/healthz"` or `"releases"`).
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    static func get(path: String, timeout: TimeInterval = 30) async throws -> Response {
        let request = try buildRequest(path: path, method: "GET", timeout: timeout)
        return try await execute(request)
    }

    /// Performs an authenticated POST request against the platform assistant proxy.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/assistants/` (e.g. `"upgrade"` or `"backups"`).
    ///   - body: Optional HTTP body data.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    static func post(path: String, body: Data? = nil, timeout: TimeInterval = 30) async throws -> Response {
        var request = try buildRequest(path: path, method: "POST", timeout: timeout)
        request.httpBody = body
        return try await execute(request)
    }

    // MARK: - Internals

    /// Resolves the currently connected assistant from the lockfile.
    private static func resolveConnectedAssistant() -> LockfileAssistant? {
        guard let id = UserDefaults.standard.string(forKey: "connectedAssistantId"), !id.isEmpty else { return nil }
        return LockfileAssistant.loadByName(id)
    }

    /// Builds an authenticated `URLRequest` for the platform assistant proxy,
    /// automatically resolving the connected assistant and auth credentials.
    private static func buildRequest(
        path: String,
        method: String,
        timeout: TimeInterval
    ) throws -> URLRequest {
        guard let assistant = resolveConnectedAssistant() else {
            throw ClientError.noConnectedAssistant
        }
        guard let token = SessionTokenManager.getToken(), !token.isEmpty else {
            throw ClientError.notAuthenticated
        }

        let baseURL = assistant.runtimeUrl ?? AuthService.shared.baseURL
        let trailingSlash = path.hasSuffix("/") ? "" : "/"
        guard let url = URL(string: "\(baseURL)/v1/assistants/\(path)\(trailingSlash)") else {
            throw ClientError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")

        if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId"), !orgId.isEmpty {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }

        return request
    }

    /// Executes a `URLRequest` and wraps the result in a `Response`.
    private static func execute(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
        return Response(data: data, statusCode: statusCode)
    }
}
